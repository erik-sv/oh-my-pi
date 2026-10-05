/**
 * Session-event forwarding for RPC mode: stamps message lifecycle frames with a
 * `messageId` and applies the host's `set_event_filter` selection.
 */
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../../session/agent-session";
import type {
	RpcDeltaMessageUpdateFrame,
	RpcMessageEventFrame,
	RpcMessageEventType,
	RpcMessageUpdates,
	RpcProjectedSessionEventFrame,
} from "./rpc-types";

/** Drops the accumulated snapshot a streaming event carries; `done` and `error` have none. */
function withoutPartial(event: AssistantMessageEvent): RpcDeltaMessageUpdateFrame["assistantMessageEvent"] {
	if (!("partial" in event)) return event;
	const { partial: _partial, ...increment } = event;
	return increment;
}

/**
 * Writes session events to the RPC output. Message ids are assigned whether or
 * not the frame passes the filter, so changing the filter mid-message never
 * splits one message across two ids.
 *
 * AgentDesk fork: ids are written only after the host sends `set_event_filter`.
 * Hosts that never opt in (AgentDesk) prefer a frame `messageId` over the
 * provider `responseId` they reconcile persisted history with, and `msg-N`
 * restarts in every process, so stamping by default collides across restarts.
 */
export class RpcSessionEventForwarder {
	#filter: Set<string> | undefined;
	#messageUpdates: RpcMessageUpdates = "full";
	#stampMessageIds = false;
	#messageCount = 0;
	/** Ids of started, unfinished messages. External records (advisor cards, IRC) nest inside a streaming reply. */
	#openMessageIds: string[] = [];
	readonly #output: (frame: RpcProjectedSessionEventFrame) => void;

	constructor(output: (frame: RpcProjectedSessionEventFrame) => void) {
		this.#output = output;
	}

	/** Forward only the listed event types; `null` forwards everything. Returns the active selection. */
	setFilter(events: readonly string[] | null, messageUpdates: RpcMessageUpdates = "full"): string[] | null {
		this.#filter = events === null ? undefined : new Set(events);
		this.#messageUpdates = messageUpdates;
		this.#stampMessageIds = true;
		return this.#filter ? Array.from(this.#filter) : null;
	}

	forward(event: AgentSessionEvent): void {
		const frame = this.#stamp(event);
		if (!this.#stampMessageIds) {
			this.#output(event);
			return;
		}
		if (this.#filter && !this.#filter.has(frame.type)) return;
		if (frame.type === "message_update" && this.#messageUpdates === "delta") {
			this.#output({
				...frame,
				message: { role: frame.message.role },
				assistantMessageEvent: withoutPartial(frame.assistantMessageEvent),
			});
			return;
		}
		this.#output(frame);
	}

	#stamp(event: AgentSessionEvent): Exclude<AgentSessionEvent, { type: RpcMessageEventType }> | RpcMessageEventFrame {
		switch (event.type) {
			case "message_start": {
				const messageId = this.#mintMessageId();
				this.#openMessageIds.push(messageId);
				return { ...event, messageId };
			}
			case "message_update": {
				let messageId = this.#openMessageIds.at(-1);
				if (messageId === undefined) {
					messageId = this.#mintMessageId();
					this.#openMessageIds.push(messageId);
				}
				return { ...event, messageId };
			}
			case "message_end":
				return { ...event, messageId: this.#openMessageIds.pop() ?? this.#mintMessageId() };
			case "agent_end":
				// A run never leaves a message open; drop anything a dropped frame stranded.
				this.#openMessageIds.length = 0;
				return event;
			default:
				return event;
		}
	}

	#mintMessageId(): string {
		return `msg-${++this.#messageCount}`;
	}
}
