import { describe, expect, it } from "bun:test";
import {
	BlobStore,
	blobExtensionForImageMimeType,
	externalizeImageData,
	parseBlobRef,
	resolveImageData,
} from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("BlobStore image display paths", () => {
	it("creates an extension-bearing sidecar for image blobs while keeping canonical refs extensionless", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");

		const result = await store.put(data, { extension: "png" });
		expect(result.path.endsWith(result.hash)).toBe(true);
		expect(result.displayPath).toBe(`${result.path}.png`);
		expect(result.ref).toBe(`blob:sha256:${result.hash}`);
		expect(await Bun.file(result.path).bytes()).toEqual(new Uint8Array(data));
		expect(await Bun.file(result.displayPath).bytes()).toEqual(new Uint8Array(data));
	});

	it("externalizes image data with a mime-derived display extension", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);

		const ref = await externalizeImageData(store, data.toString("base64"), "image/png");
		const hash = parseBlobRef(ref);

		expect(hash).toBeTruthy();
		expect(await Bun.file(`${tempDir.path()}/${hash}.png`).bytes()).toEqual(new Uint8Array(data));
		expect(await resolveImageData(store, ref)).toBe(data.toString("base64"));
	});

	it("repairs a corrupt content-addressed blob atomically", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-immutable-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("immutable-image-bytes");
		const expectedHash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = `${tempDir.path()}/${expectedHash}`;
		await Bun.write(blobPath, Buffer.alloc(data.length));

		await store.put(data, { extension: "png" });

		expect(await Bun.file(blobPath).bytes()).toEqual(new Uint8Array(data));
	});

	it("repairs a corrupt content-addressed blob atomically in the synchronous path", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-immutable-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("immutable-image-bytes");
		const expectedHash = new Bun.SHA256().update(data).digest("hex");
		const blobPath = `${tempDir.path()}/${expectedHash}`;
		await Bun.write(blobPath, Buffer.alloc(data.length));

		store.putSync(data, { extension: "png" });

		expect(await Bun.file(blobPath).bytes()).toEqual(new Uint8Array(data));
	});

	it("omits persisted blobs that are not valid images", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-invalid-image-");
		const store = new BlobStore(tempDir.path());
		const invalid = Buffer.alloc(1500);
		const result = await store.put(invalid, { extension: "png" });

		expect(await resolveImageData(store, result.ref)).toBe("");
	});

	it("maps common image mime types to clickable file extensions", () => {
		expect(blobExtensionForImageMimeType("image/jpeg")).toBe("jpg");
		expect(blobExtensionForImageMimeType("image/png")).toBe("png");
		expect(blobExtensionForImageMimeType("text/plain")).toBeUndefined();
	});
});
