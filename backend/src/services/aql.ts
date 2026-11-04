// ISO 2859-1 single sampling, normal inspection, general inspection level II.
// Major defects are judged at AQL 2.5 (the PRD's standard), minor at AQL 4.0, critical at zero.
// Where the standard's table shows an arrow, the plan of the first row the arrow points to is
// used, sample size included.

const LETTERS: [number, string][] = [
  [8, "A"], [15, "B"], [25, "C"], [50, "D"], [90, "E"], [150, "F"], [280, "G"], [500, "H"],
  [1200, "J"], [3200, "K"], [10000, "L"], [35000, "M"], [150000, "N"], [500000, "P"], [Infinity, "Q"],
];
const SAMPLE: Record<string, number> = { A: 2, B: 3, C: 5, D: 8, E: 13, F: 20, G: 32, H: 50, J: 80, K: 125, L: 200, M: 315, N: 500, P: 800, Q: 1250 };
const ORDER = Object.keys(SAMPLE);

// [Ac, Re] per code letter, or "down"/"up" for the table's arrows.
type Cell = [number, number] | "down" | "up";
const AQL_2_5: Record<string, Cell> = {
  A: "down", B: "down", C: [0, 1], D: "up", E: [1, 2], F: [1, 2], G: [2, 3], H: [3, 4], J: [5, 6],
  K: [7, 8], L: [10, 11], M: [14, 15], N: [21, 22], P: "up", Q: "up",
};
const AQL_4_0: Record<string, Cell> = {
  A: "down", B: [0, 1], C: "up", D: [1, 2], E: [1, 2], F: [2, 3], G: [3, 4], H: [5, 6], J: [7, 8],
  K: [10, 11], L: [14, 15], M: [21, 22], N: "up", P: "up", Q: "up",
};

export type Plan = { letter: string; n: number; ac: number; re: number };

function resolve(table: Record<string, Cell>, letter: string): Plan {
  let i = ORDER.indexOf(letter);
  let cell = table[ORDER[i]];
  while (cell === "down" || cell === "up") {
    i += cell === "down" ? 1 : -1;
    cell = table[ORDER[i]];
  }
  return { letter: ORDER[i], n: SAMPLE[ORDER[i]], ac: cell[0], re: cell[1] };
}

export function codeLetter(lot: number): string {
  if (!Number.isInteger(lot) || lot < 2) throw new Error("Lot size must be at least 2");
  return LETTERS.find(([max]) => lot <= max)![1];
}

export function aqlPlan(lot: number) {
  const letter = codeLetter(lot);
  const major = resolve(AQL_2_5, letter);
  const minor = resolve(AQL_4_0, letter);
  const n = Math.min(lot, Math.max(major.n, minor.n));
  return { lot, letter, sample_size: n, major: { ...major, aql: 2.5 }, minor: { ...minor, aql: 4.0 }, critical: { ac: 0, re: 1 } };
}

export function aqlVerdict(lot: number, found: { critical: number; major: number; minor: number }) {
  const p = aqlPlan(lot);
  const fails: string[] = [];
  if (found.critical > p.critical.ac) fails.push("critical defects found");
  if (found.major >= p.major.re) fails.push(`major defects ${found.major} ≥ reject ${p.major.re}`);
  if (found.minor >= p.minor.re) fails.push(`minor defects ${found.minor} ≥ reject ${p.minor.re}`);
  return { plan: p, result: fails.length ? ("fail" as const) : ("pass" as const), reasons: fails };
}
