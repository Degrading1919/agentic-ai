import type {
  AgentNode,
  CapabilityNode,
  ToolCall,
  ToolDefinition,
} from "../shared/contracts.js";

const calculatorDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "calculator_evaluate",
    description:
      "Evaluate a finite arithmetic expression containing numbers, parentheses, +, -, *, /, %, and ^.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        expression: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["expression"],
    },
  },
};

export function toolDefinitions(capabilities: CapabilityNode[]): ToolDefinition[] {
  return capabilities.flatMap((capability) => {
    if (!capability.config.enabled) return [];
    if (capability.config.capabilityId === "calculator") return [calculatorDefinition];
    return [];
  });
}

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

export function executeToolCall(
  agent: AgentNode,
  capabilities: CapabilityNode[],
  call: ToolCall,
): string {
  if (call.function.name !== "calculator_evaluate") {
    throw new Error(`Tool '${call.function.name}' is not implemented.`);
  }
  const allowed = capabilities.some(
    (capability) =>
      capability.config.enabled && capability.config.capabilityId === "calculator",
  );
  if (!allowed) {
    throw new Error(
      `Topology boundary denied '${call.function.name}' for agent '${agent.name}'.`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(call.function.arguments);
  } catch {
    throw new Error("Calculator arguments were not valid JSON.");
  }
  const expression =
    typeof payload === "object" && payload !== null && "expression" in payload
      ? String(payload.expression)
      : "";
  if (!expression) throw new Error("Calculator requires an expression.");
  return String(evaluateArithmetic(expression));
}
