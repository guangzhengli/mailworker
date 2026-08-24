import type { Client } from "@cli/client";
import { emit, type OutputOptions } from "@cli/output";
import type { CapabilitiesDto } from "@mailworker/contract";
import { Command } from "commander";

export function capabilitiesCommand(client: () => Client): Command {
  return new Command("capabilities")
    .description("Show this credential's environment, limits and allowed actions")
    .option("--json", "print the full capability document")
    .action(async (options: OutputOptions) => {
      const value = await client().get<CapabilitiesDto>("/v1/capabilities");
      emit(value, options, () => humanCapabilities(value));
    });
}

function humanCapabilities(value: CapabilitiesDto): string {
  const identity = value.principal.identity?.name ?? "unbound";
  const enabled = Object.entries(value.actions)
    .filter(([, allowed]) => allowed)
    .map(([name]) => name)
    .join(", ");
  const domains = value.domains.map((one) => `${one.domain} (${one.sendingStatus})`).join(", ");

  return [
    `Environment: ${value.environment.id} (${value.environment.mode})`,
    `Principal:   ${value.principal.subject}`,
    `Identity:    ${identity}`,
    `Scopes:      ${value.principal.scopes.join(", ") || "none"}`,
    `Actions:     ${enabled || "none"}`,
    `Domains:     ${domains || "none"}`,
    `Sending:     ${value.features.sending ? "available" : "unavailable"}`,
    "",
  ].join("\n");
}
