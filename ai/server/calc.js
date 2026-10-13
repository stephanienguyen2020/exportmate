// Exact arithmetic for the `calculate` tool, so the model never does math in its head.

/** Evaluates + - * / and parentheses over numbers, without eval. */
export function evaluate(expression) {
  const src = String(expression || "").replace(/,/g, "");
  if (!src.trim() || src.length > 300 || !/^[\d\s+\-*/().]+$/.test(src)) throw new Error("Use only numbers, + - * / and parentheses");
  let i = 0;
  const skip = () => {
    while (/\s/.test(src[i] ?? "")) i++; // any whitespace the check above allows
  };
  const factor = () => {
    skip();
    if (src[i] === "-") {
      i++;
      return -factor();
    }
    if (src[i] === "(") {
      i++;
      const v = expr();
      skip();
      if (src[i++] !== ")") throw new Error("Missing )");
      return v;
    }
    const m = src.slice(i).match(/^\d+(\.\d+)?/);
    if (!m) throw new Error(`Unexpected "${src[i] ?? "end"}"`);
    i += m[0].length;
    return Number(m[0]);
  };
  const term = () => {
    let v = factor();
    for (skip(); src[i] === "*" || src[i] === "/"; skip()) {
      const op = src[i++];
      const r = factor();
      if (op === "/" && r === 0) throw new Error("Division by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const expr = () => {
    let v = term();
    for (skip(); src[i] === "+" || src[i] === "-"; skip()) v = src[i++] === "+" ? v + term() : v - term();
    return v;
  };
  const value = expr();
  skip();
  if (i < src.length) throw new Error(`Unexpected "${src[i]}"`);
  return Math.round(value * 100) / 100;
}
