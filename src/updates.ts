import { translateUi } from "./i18n";
/** One line about the updater's state, shared by the start screen and Settings. */
export function updateSummary(status: UpdateStatus): string {
  switch (status.state) {
    case "checking": return translateUi("Checking for updates…");
    case "downloading": return translateUi("Downloading {v0} ({v1}%)", { v0: status.version, v1: status.percent ?? 0 });
    case "ready": return translateUi("Version {v0} is ready to install.", { v0: status.version });
    case "available": return translateUi("Folio {v0} is available to download.", { v0: status.version });
    case "latest": return translateUi("You're up to date.");
    case "error": return translateUi("Couldn't check for updates. {v0}", { v0: status.message ?? translateUi("Try again.") });
    case "unsupported":
      return status.message === "system" ? translateUi("Updates arrive with your system's software updates (apt).") : translateUi("This copy doesn't update itself.");
    default: return "";
  }
}
