/**
 * claude_code_configure tool - Runtime configuration management
 */
import { ErrorCode } from "../types.js";
import type { ConfigureAction } from "../types.js";

export interface ClaudeCodeConfigureInput {
  action: ConfigureAction;
}

export interface ConfigureResult {
  allowBypass: boolean;
  message: string;
  isError?: boolean;
}

export function executeClaudeCodeConfigure(
  input: ClaudeCodeConfigureInput,
  config: { getAllowBypass: () => boolean; setAllowBypass: (v: boolean) => void }
): ConfigureResult {
  switch (input.action) {
    case "enable_bypass":
      config.setAllowBypass(true);
      return {
        allowBypass: true,
        message: "bypassPermissions mode is now enabled for this server session. Use with caution.",
      };

    case "disable_bypass":
      config.setAllowBypass(false);
      return {
        allowBypass: false,
        message: "bypassPermissions mode is now disabled.",
      };

    case "get_config":
      return {
        allowBypass: config.getAllowBypass(),
        message: `Current config: bypassPermissions ${config.getAllowBypass() ? "enabled" : "disabled"}.`,
      };

    default:
      return {
        allowBypass: config.getAllowBypass(),
        message: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${input.action}'. Use 'enable_bypass', 'disable_bypass', or 'get_config'.`,
        isError: true,
      };
  }
}
