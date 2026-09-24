/**
 * Safe arithmetic for the built-in calculator capability. A small
 * recursive-descent parser; it never evaluates JavaScript.
 */
class ArithmeticParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse(): number {
    if (this.input.length > 200) throw new Error("Expression is too long.");
    if (!/^[0-9eE+\-*/%^().\s]+$/.test(this.input)) {
      throw new Error("Expression contains unsupported characters.");
    }
    const value = this.expression();
    this.whitespace();
    if (this.index !== this.input.length) {
      throw new Error(`Unexpected token at position ${this.index + 1}.`);
    }
    if (!Number.isFinite(value)) throw new Error("Result is not finite.");
    return value;
  }

  private expression(): number {
    let value = this.term();
    while (true) {
      this.whitespace();
      if (this.consume("+")) value += this.term();
      else if (this.consume("-")) value -= this.term();
      else return value;
    }
  }

  private term(): number {
    let value = this.power();
    while (true) {
      this.whitespace();
      if (this.consume("*")) value *= this.power();
      else if (this.consume("/")) {
        const divisor = this.power();
        if (divisor === 0) throw new Error("Division by zero.");
        value /= divisor;
      } else if (this.consume("%")) {
        const divisor = this.power();
        if (divisor === 0) throw new Error("Division by zero.");
        value %= divisor;
      } else return value;
    }
  }

  private power(): number {
    const base = this.unary();
    this.whitespace();
    return this.consume("^") ? base ** this.power() : base;
  }

  private unary(): number {
    this.whitespace();
    if (this.consume("+")) return this.unary();
    if (this.consume("-")) return -this.unary();
    return this.primary();
  }

  private primary(): number {
    this.whitespace();
    if (this.consume("(")) {
      const value = this.expression();
      this.whitespace();
      if (!this.consume(")")) throw new Error("Missing closing parenthesis.");
      return value;
    }

    const rest = this.input.slice(this.index);
    const match = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error(`Expected a number at position ${this.index + 1}.`);
    this.index += match[0].length;
    return Number(match[0]);
  }

  private whitespace(): void {
    while (/\s/.test(this.input[this.index] ?? "")) this.index += 1;
  }

  private consume(token: string): boolean {
    if (this.input.startsWith(token, this.index)) {
      this.index += token.length;
      return true;
    }
    return false;
  }
}

export function evaluateArithmetic(expression: string): number {
  return new ArithmeticParser(expression).parse();
}
