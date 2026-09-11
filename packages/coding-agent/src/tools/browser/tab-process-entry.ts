import type { WorkerInbound, WorkerOutbound } from "./tab-protocol";
import { WorkerCore } from "./tab-worker";

/** Start browser execution inside a subprocess so native faults cannot terminate the agent. */
export function startTabProcess(transport: {
	send(message: WorkerOutbound): void;
	onMessage(handler: (message: WorkerInbound) => void): () => void;
}): void {
	new WorkerCore(
		{
			send: message => transport.send(message as WorkerOutbound),
			onMessage: handler => transport.onMessage(handler as (message: WorkerInbound) => void),
			// The parent owns process lifetime and kills the subprocess after the
			// WorkerCore `closed` acknowledgement has crossed IPC.
			close: () => {},
		},
		true,
	);
}
