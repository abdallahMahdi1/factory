// Verifies that a job can't be finished with required cells left blank.
//
// Reads the REAL findIncompleteRows() out of renderer/app.js rather than
// duplicating it, so this test can't silently drift from shipped code.
// Run: node test/test-required-fields.js
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "..", "renderer", "app.js"), "utf8");

// Pull the REAL function source out of app.js so we're testing shipped code,
// not a copy that could drift.
const start = src.indexOf("function findIncompleteRows()");
if (start === -1) { console.log("FAIL: findIncompleteRows not found"); process.exit(1); }
let depth = 0, i = src.indexOf("{", start), end = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === "{") depth++;
  else if (src[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
}
const fnSrc = src.slice(start, end);

let SCREENS = [], ROWS = {};
const currentScreens = () => SCREENS;
const currentRows = (k) => ROWS[k] || [];
const findIncompleteRows = eval(`(${fnSrc.replace("function findIncompleteRows()", "function ()")})`);

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`OK   ${label}`);
};

const F = (id, label, required) => ({ id, label, required });
SCREENS = [
  { key: "start", label: "Input", fields: [F("m","Material",1), F("t","Tool",1), F("n","Notes",0)] },
  { key: "stop",  label: "Output", fields: [F("d","Drum No",1)] },
];

// 1. Completely empty row -> both required fields reported
ROWS = { start: [{}], stop: [{ d: "D-1" }] };
check("empty row flags both required fields",
  findIncompleteRows().map(p => [p.screenLabel, p.rowNumber, p.missing]),
  [["Input", 1, ["Material","Tool"]]]);

// 2. Partially filled -> only the missing one
ROWS = { start: [{ m: "Steel" }], stop: [{ d: "D-1" }] };
check("partial row flags only the blank one",
  findIncompleteRows().map(p => p.missing), [["Tool"]]);

// 3. Whitespace only counts as empty (a space is not data)
ROWS = { start: [{ m: "Steel", t: "   " }], stop: [{ d: "D-1" }] };
check("whitespace-only counts as blank", findIncompleteRows().map(p => p.missing), [["Tool"]]);

// 4. Optional field blank is fine
ROWS = { start: [{ m: "Steel", t: "Lathe" }], stop: [{ d: "D-1" }] };
check("optional field may stay blank", findIncompleteRows(), []);

// 5. Second row incomplete -> correct row number
ROWS = { start: [{ m:"S", t:"L" }, { m:"S" }], stop: [{ d:"D-1" }] };
check("reports the right row number",
  findIncompleteRows().map(p => [p.rowNumber, p.missing]), [[2, ["Tool"]]]);

// 6. Problems across multiple screens
ROWS = { start: [{ m:"S" }], stop: [{}] };
check("flags every screen with problems",
  findIncompleteRows().map(p => [p.screenLabel, p.missing]),
  [["Input",["Tool"]], ["Output",["Drum No"]]]);

// 7. Zero is a real value, not blank — a numeric 0 must be accepted
ROWS = { start: [{ m:"S", t:"L" }], stop: [{ d: 0 }] };
check("numeric zero counts as filled", findIncompleteRows(), []);

// 8. All good
ROWS = { start: [{ m:"S", t:"L", n:"" }], stop: [{ d:"D-1" }] };
check("fully filled passes", findIncompleteRows(), []);

console.log(fails === 0 ? "\nALL VALIDATION TESTS PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
