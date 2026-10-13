import assert from "node:assert/strict";
import { test } from "node:test";

import { csvShape } from "./data";

test("csvShape: header excluded, trailing newline is not a row, quoted newlines stay in one row", () => {
  assert.deepEqual(csvShape("Name,Firm\nDana,Harbor\nMarcus,Juniper\n"), { rows: 2, columns: 2 });
  assert.deepEqual(csvShape('Name,Notes\nDana,"line one\nline two"\n\n'), { rows: 1, columns: 2 });
  assert.deepEqual(csvShape("Name;Firm;Email\r\nDana;Harbor;d@example.com"), { rows: 1, columns: 3 });
  assert.deepEqual(csvShape(""), { rows: 0, columns: 0 });
});
