import { render } from "preact";
import "../../renderer/styles.css";
import "./shell.css";
import { Shell } from "./Shell";
import { windowBridgeData } from "./data";
import { openSettingsHash } from "../../src/shell/dead-actions-model";

if (navigator.userAgent.includes("Electron")) document.body.classList.add("is-electron");

const data = windowBridgeData();

render(<Shell data={data} />, document.getElementById("root")!);

// Menu/tray "Settings…" is a main-process IPC message, not a DOM event.
data.onOpenSettings?.(() => openSettingsHash(window));
