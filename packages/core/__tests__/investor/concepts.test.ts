/**
 * Concept taxonomy — DAG integrity checks (MONEY-787, B2).
 *
 * Asserts the prerequisite graph is a valid DAG (no cycle, no self-loop), that
 * every referenced prerequisite id resolves to a real concept, and that the
 * lookup helpers behave.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allConcepts,
  conceptsByDomain,
  getConcept,
  type ConceptDomain,
} from "../../src/investor/concepts";

describe("concept taxonomy", () => {
  it("has a non-empty, unique set of concept ids", () => {
    const concepts = allConcepts();
    assert.ok(concepts.length > 0);
    const ids = concepts.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate concept id found");
  });

  it("every prerequisite id references an existing concept", () => {
    for (const c of allConcepts()) {
      for (const pre of c.prerequisiteConceptIds) {
        assert.ok(
          getConcept(pre),
          `concept "${c.id}" lists unknown prerequisite "${pre}"`,
        );
      }
    }
  });

  it("no concept lists itself as a prerequisite (no self-loop)", () => {
    for (const c of allConcepts()) {
      assert.ok(
        !c.prerequisiteConceptIds.includes(c.id),
        `concept "${c.id}" depends on itself`,
      );
    }
  });

  it("the prerequisite graph is acyclic (topological sort succeeds)", () => {
    const concepts = allConcepts();
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // pre -> [concepts requiring it]

    for (const c of concepts) {
      indegree.set(c.id, c.prerequisiteConceptIds.length);
    }
    for (const c of concepts) {
      for (const pre of c.prerequisiteConceptIds) {
        const arr = dependents.get(pre) ?? [];
        arr.push(c.id);
        dependents.set(pre, arr);
      }
    }

    // Kahn's algorithm: repeatedly remove zero-indegree nodes.
    const queue = concepts
      .filter((c) => indegree.get(c.id) === 0)
      .map((c) => c.id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift() as string;
      visited++;
      for (const dep of dependents.get(id) ?? []) {
        const d = (indegree.get(dep) ?? 0) - 1;
        indegree.set(dep, d);
        if (d === 0) queue.push(dep);
      }
    }

    assert.equal(
      visited,
      concepts.length,
      "cycle detected — not all concepts were topologically ordered",
    );
  });

  it("has at least one root concept (no prerequisites)", () => {
    const roots = allConcepts().filter(
      (c) => c.prerequisiteConceptIds.length === 0,
    );
    assert.ok(roots.length > 0, "no root concept — graph cannot be a DAG");
    assert.ok(roots.some((c) => c.id === "asset.equity"));
  });
});

describe("lookup helpers", () => {
  it("getConcept resolves a known id and returns undefined otherwise", () => {
    assert.equal(getConcept("valuation.pe-ratio")?.name, "P/E Ratio");
    assert.equal(getConcept("does.not.exist"), undefined);
  });

  it("conceptsByDomain returns only that domain, sorted by order", () => {
    const domains: ConceptDomain[] = [
      "asset-classes",
      "valuation",
      "risk",
      "derivatives",
      "taxation",
      "portfolio",
      "macro",
    ];
    for (const domain of domains) {
      const list = conceptsByDomain(domain);
      assert.ok(list.length > 0, `domain ${domain} is empty`);
      for (const c of list) assert.equal(c.domain, domain);
      const orders = list.map((c) => c.order);
      const sorted = [...orders].sort((a, b) => a - b);
      assert.deepEqual(orders, sorted, `domain ${domain} not sorted by order`);
    }
  });

  it("the union of all domains equals the full concept set", () => {
    const total =
      conceptsByDomain("asset-classes").length +
      conceptsByDomain("valuation").length +
      conceptsByDomain("risk").length +
      conceptsByDomain("derivatives").length +
      conceptsByDomain("taxation").length +
      conceptsByDomain("portfolio").length +
      conceptsByDomain("macro").length;
    assert.equal(total, allConcepts().length);
  });
});
