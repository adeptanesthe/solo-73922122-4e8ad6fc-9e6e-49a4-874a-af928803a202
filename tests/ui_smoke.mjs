/* Headless smoke test of the UI against a live server using jsdom.
 *
 * Usage: node tests/ui_smoke.mjs http://127.0.0.1:8123
 * Requires jsdom available from the working directory (see README).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// jsdom is an optional dev dependency; point JSDOM_DIR at a node_modules
// directory that contains it when it is not installed next to this file.
const require = createRequire(
  process.env.JSDOM_DIR ? path.join(process.env.JSDOM_DIR, "noop.js") : import.meta.url,
);
const { JSDOM, VirtualConsole } = require("jsdom");

const BASE = process.argv[2] || "http://127.0.0.1:8123";
const root = path.resolve(new URL("..", import.meta.url).pathname);

const html = fs.readFileSync(path.join(root, "app/static/index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "app/static/app.js"), "utf8");

const virtualConsole = new VirtualConsole();
const errors = [];
virtualConsole.on("jsdomError", (e) => errors.push(String(e)));
virtualConsole.on("error", (e) => errors.push(String(e)));

const dom = new JSDOM(html, {
  url: BASE + "/",
  runScripts: "outside-only",
  virtualConsole,
  pretendToBeVisual: true,
});
const { window } = dom;
window.fetch = (input, init) => fetch(new URL(input, BASE), init);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error("timeout waiting for " + label);
}
const $ = (id) => window.document.getElementById(id);

window.eval(script);
await sleep(200);

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

// 1. samples are listed
await until(() => $("sample-buttons").children.length > 0, "sample buttons");
check("样例按钮已渲染", $("sample-buttons").children.length >= 3,
  $("sample-buttons").textContent.trim());

// 2. load the repeat sample
const repeatBtn = [...$("sample-buttons").children].find((b) => b.textContent.includes("sample_repeat"));
repeatBtn.click();
await until(() => !$("workspace").hidden && $("progress-text").textContent !== "0 / 0 帧", "sample loaded");
check("载入样例后显示工作区", !$("workspace").hidden, $("progress-text").textContent);
check("初始无候选字幕", $("confirmed-text").textContent === "", `“${$("confirmed-text").textContent}”`);

// 3. advance one chunk
window.document.getElementById("chunk-size").value = "5";
$("chunk-size").dispatchEvent(new window.Event("input"));
$("step-btn").click();
await until(() => $("progress-text").textContent.startsWith("5 /"), "advance chunk");
check("分块推进更新进度", $("progress-text").textContent.startsWith("5 /"), $("progress-text").textContent);
check("候选表非空", $("beam-body").children.length > 0, `${$("beam-body").children.length} 束`);
const firstText = $("beam-body").children[0].querySelector(".beam-text").textContent;
check("最佳候选含字符", firstText.length > 0, firstText);

// 4. confirm the best candidate
$("confirm-best").click();
await until(() => $("confirmed-text").textContent.length > 0, "confirm");
const confirmed = $("confirmed-text").textContent;
check("确认后前缀显示", confirmed.length > 0, confirmed);
check("blank 分数显示", $("ps-blank").textContent !== "—", $("ps-blank").textContent);
check("非 blank 分数显示", $("ps-nonblank").textContent !== "—", $("ps-nonblank").textContent);
check("撤销按钮可用", !$("undo-btn").disabled);

// 5. advance after confirmation, then undo
$("step-btn").click();
await until(() => $("progress-text").textContent.startsWith("10 /"), "advance after confirm");
$("undo-btn").click();
await until(() => $("confirmed-text").textContent === "", "undo");
check("撤销后前缀清空", $("confirmed-text").textContent === "");
check("撤销后进度保留", $("progress-text").textContent.startsWith("10 /"), $("progress-text").textContent);
check("撤销后候选非空", $("beam-body").children.length > 0);

// 6. failure keeps state: confirm text not in beam
$("prefix-input").value = "zzzz";
$("apply-prefix").click();
await until(() => !$("op-error").hidden, "error shown");
const beforeProgress = $("progress-text").textContent;
check("非法确认显示错误", !$("op-error").hidden, $("op-error").textContent);
check("错误后进度不变", $("progress-text").textContent === beforeProgress, $("progress-text").textContent);

// 7. historical frame inspection
$("peek-frame").value = "2";
$("peek-frame").dispatchEvent(new window.Event("input"));
await sleep(400);
check("历史帧提示只读", $("peek-note").textContent.includes("历史回放"), $("peek-note").textContent);
check("历史帧概率已渲染", $("frame-probs").children.length > 0);

// 8. continuous run to the end
$("peek-frame").value = $("peek-frame").max;
$("peek-frame").dispatchEvent(new window.Event("input"));
$("run-btn").click();
await until(() => $("progress-text").textContent.startsWith("15 / 15"), "run to end", 30000);
check("连续推进到结尾", $("progress-text").textContent.startsWith("15 / 15"), $("progress-text").textContent);
await until(() => $("stop-btn").hidden, "run loop finished");
check("运行结束停止按钮隐藏", $("stop-btn").hidden);

// 9. zero-probability sample shows -∞ without NaN
const zeroBtn = [...$("sample-buttons").children].find((b) => b.textContent.includes("sparse_zero"));
zeroBtn.click();
await until(() => $("progress-text").textContent.startsWith("0 / 7"), "zero sample loaded");
$("step-btn").click();
await until(() => $("progress-text").textContent.startsWith("7 / 7") || $("progress-text").textContent.startsWith("5 / 7"), "zero sample advance");
await sleep(300);
const bodyText = $("beam-body").textContent;
check("零概率样例无 NaN", !bodyText.includes("NaN"), bodyText.slice(0, 120));
check("零概率样例显示 -∞", bodyText.includes("-∞") || $("frame-probs").textContent.includes("0.000"));

// 10. column/character mismatch diagnosis panel
const diagPanel = $("diagnosis-panel");
check("诊断面板已渲染", !!diagPanel && !diagPanel.hidden);
const colBoxes = [...$("diag-columns").querySelectorAll("input[type=checkbox]")];
check("诊断列复选框为非 blank 列", colBoxes.length === 3 && !colBoxes.some((b) => b.value === "0"),
  `${colBoxes.length} columns`);
// select two columns (x=#1, y=#2); z stays fixed
colBoxes.find((b) => b.value === "1").click();
colBoxes.find((b) => b.value === "2").click();
// fill one segment covering the advanced frames with a reachable subtitle
const segRows = [...$("diag-segments").children];
const segInputs = segRows[0].querySelectorAll("input");
segInputs[0].value = "0";
segInputs[0].dispatchEvent(new window.Event("input"));
segInputs[1].value = "4";
segInputs[1].dispatchEvent(new window.Event("input"));
segInputs[2].value = "x";
segInputs[2].dispatchEvent(new window.Event("input"));
$("diag-run").click();
await until(() => $("diag-result").children.length > 0, "diagnosis result", 20000);
const verdictText = $("diag-result").textContent;
check("诊断给出映射表", $("diag-result").querySelectorAll(".diag-table tbody tr").length === 2,
  `${$("diag-result").querySelectorAll(".diag-table tbody tr").length} rows`);
check("诊断报告最优结论", verdictText.includes("最优映射"), verdictText.slice(0, 80));
check("诊断表保留原帧号与字幕", verdictText.includes("帧 0–3") && verdictText.includes("「x」"));

// 11. advancing frames marks the previous diagnosis stale instead of overwriting
$("step-btn").click();
await sleep(600);
check("推进后旧诊断标记过期", $("diag-result").textContent.includes("已过期"),
  $("diag-result").querySelector(".stale-banner")?.textContent.slice(0, 60) || "no banner");

// 12. invalid diagnosis (overlapping segments) surfaces an error and changes nothing
$("diag-add-seg").click();
const rows2 = [...$("diag-segments").children];
check("可添加第二个片段", rows2.length === 2);
const secondInputs = rows2[1].querySelectorAll("input");
secondInputs[0].value = "2";
secondInputs[0].dispatchEvent(new window.Event("input"));
secondInputs[1].value = "6";
secondInputs[1].dispatchEvent(new window.Event("input"));
secondInputs[2].value = "y";
secondInputs[2].dispatchEvent(new window.Event("input"));
const progressBeforeDiag = $("progress-text").textContent;
$("diag-run").click();
await until(() => !$("diag-error").hidden, "diagnosis error");
check("重叠片段报错", $("diag-error").textContent.includes("重叠"), $("diag-error").textContent);
check("诊断失败不改动进度", $("progress-text").textContent === progressBeforeDiag);

// 12b. symmetric columns must surface a tie verdict through the real panel,
// never a unique claim.  A bundled sample provides the symmetric data.
await until(() => [...$("sample-buttons").children].some((b) => b.textContent.includes("sample_tie")),
  "tie sample button");
const tieBtn = [...$("sample-buttons").children].find((b) => b.textContent.includes("sample_tie"));
tieBtn.click();
await until(() => $("progress-text").textContent.startsWith("0 / 3"), "tie sample loaded");
$("step-btn").click();
await until(() => $("progress-text").textContent.startsWith("3 / 3"), "tie sample advanced");
const tieBoxes = [...$("diag-columns").querySelectorAll("input[type=checkbox]")];
tieBoxes.find((b) => b.value === "1").click();
tieBoxes.find((b) => b.value === "2").click();
const tieRows = [...$("diag-segments").children];
const tieInputs = tieRows[0].querySelectorAll("input");
tieInputs[0].value = "0";
tieInputs[0].dispatchEvent(new window.Event("input"));
tieInputs[1].value = "3";
tieInputs[1].dispatchEvent(new window.Event("input"));
tieInputs[2].value = "a";
tieInputs[2].dispatchEvent(new window.Event("input"));
$("diag-run").click();
await until(() => $("diag-result").textContent.includes("同分最优映射"), "tie verdict");
const tieVerdict = $("diag-result").querySelector(".diag-verdict");
check("并列时显示同分最优而非唯一", tieVerdict.classList.contains("tied") && !tieVerdict.classList.contains("unique"),
  tieVerdict.querySelector(".v-title").textContent);
check("并列映射行数为 2", $("diag-result").querySelectorAll("tr.opt").length === 2);

// 13. no uncaught UI errors
check("无未捕获脚本错误", errors.length === 0, errors.join(" | ").slice(0, 200));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
