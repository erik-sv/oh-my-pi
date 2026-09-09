/**
 * Show every authenticated provider account and its reported usage windows.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { accountHelp as commandHelp } from "../cli/command-help";
import { runAccountCommand } from "../cli/usage-cli";

export default class Account extends Command {
	static description = commandHelp.description;

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output the usage report contract as JSON", default: false }),
		provider: Flags.string({ char: "p", description: "Only show accounts for this provider id (e.g. anthropic)" }),
		redact: Flags.boolean({
			char: "r",
			description: "Redact account emails/ids (shortest unique prefix) for sharing screenshots",
			default: false,
		}),
	};

	static examples = [
		"# All provider subscriptions grouped by account\n  omp account",
		"# Only Anthropic accounts\n  omp account --provider anthropic",
		"# Machine-readable output (same contract as omp usage --json)\n  omp account --json",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Account);
		await runAccountCommand({ json: flags.json, provider: flags.provider, redact: flags.redact });
	}
}
