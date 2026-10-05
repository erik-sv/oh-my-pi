import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	resolveBlobRefsInEntries,
	resolveBlobRefsInEntriesSync,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

// Fork: hydration validates image bytes, so fixtures carry a PNG signature.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(payload: Uint8Array): Buffer<ArrayBuffer> {
	return Buffer.from(Buffer.concat([PNG_SIGNATURE, payload]));
}
const OMITTED_IMAGE: unknown = { type: "text", text: "[image omitted: persisted image is unavailable]" };
function entry(images: ImageContent[], details: Record<string, unknown> = {}): SessionMessageEntry {
	return {
		type: "message",
		id: "images",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "image-read",
			toolName: "read",
			content: images,
			details,
			isError: false,
			timestamp: 0,
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("session image blob hydration", () => {
	it("reads repeated image references once while restoring distinct images and generated results", async () => {
		using tempDir = TempDir.createSync("@session-blob-dedup-");
		const store = new BlobStore(tempDir.path());
		const bytes = png(Buffer.from([0, 1, 127, 128, 255]));
		const otherBytes = png(Buffer.from([255, 128, 127, 1, 0]));
		const { ref } = store.putSync(bytes);
		const other = store.putSync(otherBytes);
		const images = [image(ref), image(ref), image(other.ref)];
		const details = {
			images: [image(ref)],
			generated: { type: "image_generation_call", result: ref },
			unrelatedReference: ref,
		};
		const read = vi.spyOn(store, "get");

		await resolveBlobRefsInEntries([entry(images, details)], store);

		expect(read).toHaveBeenCalledTimes(2);
		expect(images.map(value => Buffer.from(value.data, "base64"))).toEqual([bytes, bytes, otherBytes]);
		expect(Buffer.from(details.images[0]!.data, "base64")).toEqual(bytes);
		expect(Buffer.from(details.generated.result, "base64")).toEqual(bytes);
		expect(details.unrelatedReference).toBe(ref);
	});

	it.each(["synchronous", "asynchronous"] as const)(
		"shares %s resolutions without mixing provider URLs and base64 image data",
		async mode => {
			using tempDir = TempDir.createSync("@session-blob-dedup-sync-");
			const store = new BlobStore(tempDir.path());
			const dataUrl = "data:image/png;base64,AAECAw==";
			const bytes = Buffer.from(dataUrl);
			const { ref } = store.putSync(bytes);
			const empty = store.putSync(Buffer.alloc(0));
			const images = [image(ref), image(ref)];
			const details = {
				urls: [{ image_url: ref }, { image_url: ref }],
				empty: { images: [image(empty.ref), image(empty.ref)] },
			};
			const read = vi.spyOn(store, mode === "synchronous" ? "getSync" : "get");
			const entries = [entry(images, details)];

			if (mode === "synchronous") resolveBlobRefsInEntriesSync(entries, store);
			else await resolveBlobRefsInEntries(entries, store);

			expect(read).toHaveBeenCalledTimes(3);
			// Fork: the base64 resolution of a non-image blob degrades to text while the
			// provider-URL resolution of the same reference still yields the data URL.
			expect(images as unknown[]).toEqual([OMITTED_IMAGE, OMITTED_IMAGE]);
			expect(details.urls.map(value => value.image_url)).toEqual([dataUrl, dataUrl]);
			expect(details.empty.images as unknown[]).toEqual([OMITTED_IMAGE, OMITTED_IMAGE]);
		},
	);

	it("bounds concurrent reads of distinct images while sharing pending resolutions", async () => {
		using tempDir = TempDir.createSync("@session-blob-dedup-concurrency-");
		const store = new BlobStore(tempDir.path());
		const values = Array.from({ length: 16 }, (_, index) => png(Buffer.alloc(16, index)));
		const refs = values.map(value => store.putSync(value).ref);
		const images = refs.flatMap(ref => [image(ref), image(ref)]);
		const readBlob = store.get.bind(store);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		let active = 0;
		let maximum = 0;
		let reads = 0;
		const read = vi.spyOn(store, "get").mockImplementation(async hash => {
			active++;
			maximum = Math.max(maximum, active);
			if (++reads === 8) started.resolve();
			try {
				await gate.promise;
				return await readBlob(hash);
			} finally {
				active--;
			}
		});

		const hydration = resolveBlobRefsInEntries([entry(images)], store);
		try {
			await started.promise;
			expect(read).toHaveBeenCalledTimes(8);
		} finally {
			gate.resolve();
		}
		await hydration;

		expect(maximum).toBe(8);
		expect(read).toHaveBeenCalledTimes(values.length);
		expect(images.map(value => Buffer.from(value.data, "base64"))).toEqual(values.flatMap(value => [value, value]));
	});

	it.each(["synchronous", "asynchronous"] as const)(
		"degrades missing references, leaves malformed ones intact, and resolves them on the next %s load",
		async mode => {
			using tempDir = TempDir.createSync("@session-blob-dedup-missing-");
			const store = new BlobStore(tempDir.path());
			const bytes = png(Buffer.from("published after the first load"));
			const ref = `blob:sha256:${new Bun.SHA256().update(bytes).digest("hex")}`;
			const malformed = "blob:sha256:not-a-hash";
			const images = [image(ref), image(ref), image(malformed)];
			const read = vi.spyOn(store, mode === "synchronous" ? "getSync" : "get");
			const entries = [entry(images)];

			if (mode === "synchronous") resolveBlobRefsInEntriesSync(entries, store);
			else await resolveBlobRefsInEntries(entries, store);

			expect(read).toHaveBeenCalledTimes(1);
			// Fork: an unavailable image degrades to text instead of replaying the reference.
			expect(images as unknown[]).toEqual([OMITTED_IMAGE, OMITTED_IMAGE, image(malformed)]);

			// A later load of the persisted entries is not served a cached miss.
			store.putSync(bytes);
			const reloaded = [image(ref), image(ref), image(malformed)];
			if (mode === "synchronous") resolveBlobRefsInEntriesSync([entry(reloaded)], store);
			else await resolveBlobRefsInEntries([entry(reloaded)], store);

			expect(read).toHaveBeenCalledTimes(2);
			expect(reloaded.map(value => value.data)).toEqual([
				bytes.toString("base64"),
				bytes.toString("base64"),
				malformed,
			]);
		},
	);

	it.each(["synchronous", "asynchronous"] as const)(
		"surfaces blob read failures and retries repaired blobs on the next %s load",
		async mode => {
			using tempDir = TempDir.createSync("@session-blob-dedup-failure-");
			const store = new BlobStore(tempDir.path());
			const bytes = png(Buffer.from("repaired after a failed load"));
			const blob = store.putSync(bytes);
			await fs.rm(blob.path);
			await fs.mkdir(blob.path);
			const images = [image(blob.ref), image(blob.ref)];
			const entries = [entry(images)];
			const read = vi.spyOn(store, mode === "synchronous" ? "getSync" : "get");

			if (mode === "synchronous") {
				expect(() => resolveBlobRefsInEntriesSync(entries, store)).toThrow(/director|permitted|denied/i);
			} else {
				await expect(resolveBlobRefsInEntries(entries, store)).rejects.toThrow(/director|permitted|denied/i);
			}
			expect(images.map(value => value.data)).toEqual([blob.ref, blob.ref]);

			await fs.rm(blob.path, { recursive: true });
			store.putSync(bytes);
			if (mode === "synchronous") resolveBlobRefsInEntriesSync(entries, store);
			else await resolveBlobRefsInEntries(entries, store);

			expect(read).toHaveBeenCalledTimes(2);
			expect(images.map(value => Buffer.from(value.data, "base64"))).toEqual([bytes, bytes]);
		},
	);
});
