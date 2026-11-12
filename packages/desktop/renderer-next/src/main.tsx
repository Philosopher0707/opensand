import { render } from "preact";
import "../../renderer/styles.css";
import "./shell.css";
import { Shell } from "./Shell";
import { windowBridgeData } from "./data";

if (navigator.userAgent.includes("Electron")) document.body.classList.add("is-electron");

const data = windowBridgeData();

render(<Shell data={data} />, document.getElementById("root")!);
