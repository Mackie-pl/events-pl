/**
 * Walidacja argumentów `discover`. Jeden przypadek jest tu ważniejszy niż reszta razem wzięta:
 * `--reset` kasuje cały rejestr, więc każda kombinacja, w której nic go potem nie odbuduje,
 * musi zostać odrzucona ZANIM cokolwiek zostanie zapisane.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseArgs } from "../src/actions/discover-args.js";

describe("parseArgs — tryby", () => {
  it("bez argumentów: pełny przebieg dla domyślnego miasta", () => {
    assert.deepEqual(parseArgs([]), {
      mode: "run", verifyOnly: false, reset: false, center: "Poznań", radius: 15,
    });
  });

  it("--verify nie rusza discovery", () => {
    const args = parseArgs(["--verify"]);
    assert.equal(args.mode === "run" && args.verifyOnly, true);
    assert.equal(args.mode === "run" && args.reset, false);
  });

  it("--why wygrywa z resztą i niesie szukaną frazę", () => {
    assert.deepEqual(parseArgs(["--why", "gok-lubon"]), { mode: "why", needle: "gok-lubon" });
  });
});

describe("parseArgs — bezpiecznik --reset", () => {
  it("--reset w pełnym przebiegu przechodzi", () => {
    const args = parseArgs(["--reset", "Poznań", "15"]);
    assert.equal(args.mode === "run" && args.reset, true);
    assert.equal(args.mode === "run" && args.center, "Poznań");
  });

  it("--reset z --verify jest odrzucone — skasowałoby rejestr bez odbudowy", () => {
    const args = parseArgs(["--reset", "--verify"]);
    assert.equal(args.mode, "usage");
    assert.match(args.mode === "usage" ? args.err : "", /--reset/);
  });

  it("zły promień jest błędem, a nie cichym domyślnym", () => {
    assert.equal(parseArgs(["Poznań", "0"]).mode, "usage");
    assert.equal(parseArgs(["Poznań", "abc"]).mode, "usage");
  });
});
