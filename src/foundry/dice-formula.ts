export const MAX_DICE_FORMULA_LENGTH = 100;
export const MAX_DICE = 1000;
export const MAX_DICE_PER_TERM = 999;
export const MAX_DICE_SIDES = 1_000_000;
export const MAX_DICE_CONSTANT = 1_000_000_000;
export const MAX_PARENTHESIS_DEPTH = 10;
export const MAX_DICE_TERMS = 50;

export type DiceModifierType = 'kh' | 'kl' | 'dh' | 'dl';

export interface DiceModifier {
  type: DiceModifierType;
  count: number;
}

export interface DiceResult {
  result: number;
  active: boolean;
}

export interface DiceOutcomes {
  faces: number;
  results: DiceResult[];
}

export interface EvaluatedDie extends DiceOutcomes {
  formula: string;
  count: number;
  modifier: DiceModifier | null;
}

export interface ConstantNode {
  kind: 'constant';
  value: number;
}

export interface DiceNode {
  kind: 'dice';
  count: number;
  faces: number;
  modifier: DiceModifier | null;
}

export interface BinaryNode {
  kind: 'binary';
  operator: '+' | '-';
  left: DiceFormulaNode;
  right: DiceFormulaNode;
}

export interface UnaryNode {
  kind: 'unary';
  operator: '+' | '-';
  operand: DiceFormulaNode;
}

export type DiceFormulaNode = ConstantNode | DiceNode | BinaryNode | UnaryNode;

export interface ParsedDiceFormula {
  ast: DiceFormulaNode;
  normalizedFormula: string;
  diceCount: number;
  termCount: number;
}

export interface RolledTerm {
  kind: 'dice' | 'constant';
  value: number;
  rolls?: number[];
}

export interface DiceFormulaResult {
  total: number;
  breakdown: string;
  terms: RolledTerm[];
  dice: EvaluatedDie[];
  normalizedFormula: string;
}

export class InvalidDiceFormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDiceFormulaError';
  }
}

function invalid(formula: string, detail: string): InvalidDiceFormulaError {
  return new InvalidDiceFormulaError(`Invalid dice formula "${formula}": ${detail}`);
}

class Parser {
  private index = 0;
  private diceCount = 0;
  private termCount = 0;

  constructor(private readonly formula: string) {}

  parse(): ParsedDiceFormula {
    if (this.formula.length > MAX_DICE_FORMULA_LENGTH) {
      throw invalid(this.formula, `the maximum length is ${MAX_DICE_FORMULA_LENGTH}.`);
    }
    if (this.formula.trim() === '') {
      throw new InvalidDiceFormulaError('Invalid dice formula: the formula is empty.');
    }

    const ast = this.expression(0);
    this.skipWhitespace();
    if (this.index !== this.formula.length) {
      throw invalid(
        this.formula,
        `unexpected "${this.formula[this.index]}" at position ${this.index}.`,
      );
    }

    return {
      ast,
      normalizedFormula: renderNode(ast, true),
      diceCount: this.diceCount,
      termCount: this.termCount,
    };
  }

  private expression(depth: number): DiceFormulaNode {
    let left = this.unary(depth);
    for (;;) {
      this.skipWhitespace();
      const operator = this.formula[this.index];
      if (operator !== '+' && operator !== '-') {
        return left;
      }
      this.index += 1;
      left = { kind: 'binary', operator, left, right: this.unary(depth) };
    }
  }

  private unary(depth: number): DiceFormulaNode {
    this.skipWhitespace();
    const operator = this.formula[this.index];
    if (operator === '+' || operator === '-') {
      this.index += 1;
      return { kind: 'unary', operator, operand: this.unary(depth) };
    }
    return this.primary(depth);
  }

  private primary(depth: number): DiceFormulaNode {
    this.skipWhitespace();
    if (this.formula[this.index] === '(') {
      if (depth >= MAX_PARENTHESIS_DEPTH) {
        throw invalid(
          this.formula,
          `parentheses may be nested at most ${MAX_PARENTHESIS_DEPTH} levels.`,
        );
      }
      this.index += 1;
      const node = this.expression(depth + 1);
      this.skipWhitespace();
      if (this.formula[this.index] !== ')') {
        throw invalid(this.formula, `expected ")" at position ${this.index}.`);
      }
      this.index += 1;
      return node;
    }

    const start = this.index;
    const digits = this.readDigits();
    if (this.formula[this.index]?.toLowerCase() === 'd') {
      this.index += 1;
      const sideDigits = this.readDigits();
      if (sideDigits === '') {
        throw invalid(this.formula, `a die needs a side count at position ${this.index}.`);
      }
      const count = digits === '' ? 1 : this.integer(digits, 'dice count');
      const faces = this.integer(sideDigits, 'side count');
      if (count > MAX_DICE_PER_TERM) {
        throw invalid(
          this.formula,
          `a dice term may request at most ${MAX_DICE_PER_TERM} results.`,
        );
      }
      if (faces < 1 || faces > MAX_DICE_SIDES) {
        throw invalid(this.formula, `die sides must be between 1 and ${MAX_DICE_SIDES}.`);
      }

      this.diceCount += count;
      if (this.diceCount > MAX_DICE) {
        throw invalid(this.formula, `the aggregate dice limit is ${MAX_DICE}.`);
      }

      let modifier: DiceModifier | null = null;
      const modifierType = this.formula.slice(this.index, this.index + 2).toLowerCase();
      if (
        modifierType === 'kh' ||
        modifierType === 'kl' ||
        modifierType === 'dh' ||
        modifierType === 'dl'
      ) {
        this.index += 2;
        const modifierDigits = this.readDigits();
        const modifierCount =
          modifierDigits === '' ? 1 : this.integer(modifierDigits, 'modifier count');
        if (modifierDigits !== '' && modifierCount === 0) {
          throw invalid(this.formula, 'an explicit modifier count must be at least 1.');
        }
        if ((count === 0 && modifierCount !== 1) || (count > 0 && modifierCount > count)) {
          throw invalid(this.formula, 'a modifier count cannot exceed the dice count.');
        }
        modifier = { type: modifierType, count: modifierCount };
      }

      this.addTerm();
      return { kind: 'dice', count, faces, modifier };
    }

    if (digits !== '') {
      const value = this.integer(digits, 'constant');
      if (value > MAX_DICE_CONSTANT) {
        throw invalid(this.formula, `constants may not exceed ${MAX_DICE_CONSTANT}.`);
      }
      this.addTerm();
      return { kind: 'constant', value };
    }

    throw invalid(
      this.formula,
      `unexpected "${this.formula[start] ?? 'end of input'}" at position ${start}.`,
    );
  }

  private addTerm(): void {
    this.termCount += 1;
  }

  private integer(raw: string, label: string): number {
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      throw invalid(this.formula, `${label} must be a safe integer.`);
    }
    return value;
  }

  private readDigits(): string {
    const start = this.index;
    while (/\d/.test(this.formula[this.index] ?? '')) {
      this.index += 1;
    }
    return this.formula.slice(start, this.index);
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.formula[this.index] ?? '')) {
      this.index += 1;
    }
  }
}

function renderNode(node: DiceFormulaNode, root = false): string {
  switch (node.kind) {
    case 'constant':
      return String(node.value);
    case 'dice':
      return `${node.count}d${node.faces}${
        node.modifier ? `${node.modifier.type}${node.modifier.count}` : ''
      }`;
    case 'unary': {
      let operand: DiceFormulaNode = node;
      let negative = false;
      while (operand.kind === 'unary') {
        if (operand.operator === '-') {
          negative = !negative;
        }
        operand = operand.operand;
      }
      if (!negative) {
        return renderNode(operand, root);
      }
      return root ? `0 - (${renderNode(operand, true)})` : `(0 - (${renderNode(operand, true)}))`;
    }
    case 'binary': {
      const expression = `${renderNode(node.left, true)} ${node.operator} ${renderNode(node.right)}`;
      return root ? expression : `(${expression})`;
    }
  }
}

export function parseDiceFormula(formula: string): ParsedDiceFormula {
  return new Parser(formula).parse();
}

function activeIndexes(values: number[], modifier: DiceModifier | null): Set<number> {
  const all = new Set(values.map((_, index) => index));
  if (!modifier || values.length === 0) {
    return all;
  }

  // Foundry preserves every result when a drop modifier requests the whole
  // term (for example, 2d6dl2). This differs from the intuitive empty set and
  // is part of the native Roll evaluation contract we validate remotely.
  if (modifier.type.startsWith('d') && modifier.count === values.length) {
    return all;
  }

  const high = modifier.type.endsWith('h');
  const ranked = values.map((value, index) => ({ value, index }));
  ranked.sort((a, b) => {
    const valueOrder = high ? b.value - a.value : a.value - b.value;
    if (valueOrder !== 0) {
      return valueOrder;
    }
    return modifier.type.startsWith('k') ? b.index - a.index : a.index - b.index;
  });

  const selected = new Set(ranked.slice(0, modifier.count).map(({ index }) => index));
  if (modifier.type.startsWith('k')) {
    return selected;
  }
  for (const index of selected) {
    all.delete(index);
  }
  return all;
}

interface EvaluationState {
  dice: EvaluatedDie[];
  terms: RolledTerm[];
  supplied?: DiceOutcomes[];
  suppliedIndex: number;
  rng: () => number;
}

function evaluateNode(node: DiceFormulaNode, state: EvaluationState): number {
  switch (node.kind) {
    case 'constant':
      state.terms.push({ kind: 'constant', value: node.value });
      return node.value;
    case 'unary': {
      const value = evaluateNode(node.operand, state);
      return node.operator === '-' ? -value : value;
    }
    case 'binary': {
      const left = evaluateNode(node.left, state);
      const right = evaluateNode(node.right, state);
      const total = node.operator === '+' ? left + right : left - right;
      if (!Number.isSafeInteger(total)) {
        throw new InvalidDiceFormulaError('Dice formula result exceeds the safe integer range.');
      }
      return total;
    }
    case 'dice': {
      let values: number[];
      let suppliedResults: DiceResult[] | undefined;
      if (state.supplied) {
        const supplied = state.supplied[state.suppliedIndex++];
        if (!supplied || supplied.faces !== node.faces || supplied.results.length !== node.count) {
          throw new Error('Foundry dice outcomes do not match the requested formula.');
        }
        suppliedResults = supplied.results;
        values = suppliedResults.map(({ result }) => result);
      } else {
        values = Array.from({ length: node.count }, () => {
          // Local evaluation always supplies an RNG. Remote validation takes
          // the supplied-outcome branch above and never evaluates randomness.
          const uniform = state.rng();
          if (
            typeof uniform !== 'number' ||
            !Number.isFinite(uniform) ||
            uniform < 0 ||
            uniform >= 1
          ) {
            throw new Error('Dice RNG must return a finite value in [0, 1).');
          }
          return Math.ceil(node.faces * (1 - uniform));
        });
      }

      if (values.some((value) => !Number.isInteger(value) || value < 1 || value > node.faces)) {
        throw new Error('Foundry returned an invalid die result.');
      }

      const active = activeIndexes(values, node.modifier);
      const ordered = values.map((result, index) => ({ result, active: active.has(index) }));

      if (suppliedResults) {
        if (
          suppliedResults.some((item, index) => {
            const expected = ordered[index] as DiceResult;
            return item.result !== expected.result || item.active !== expected.active;
          })
        ) {
          throw new Error('Foundry dice active flags do not match the requested modifier.');
        }
      }

      const die: EvaluatedDie = {
        formula: renderNode(node, true),
        count: node.count,
        faces: node.faces,
        modifier: node.modifier,
        results: ordered,
      };
      state.dice.push(die);
      const value = ordered.reduce((sum, item) => (item.active ? sum + item.result : sum), 0);
      state.terms.push({
        kind: 'dice',
        value,
        rolls: ordered.map(({ result }) => result),
      });
      return value;
    }
  }
}

function complete(parsed: ParsedDiceFormula, state: EvaluationState): DiceFormulaResult {
  const total = evaluateNode(parsed.ast, state);
  if (!Number.isSafeInteger(total)) {
    throw new InvalidDiceFormulaError('Dice formula result exceeds the safe integer range.');
  }
  if (state.supplied && state.suppliedIndex !== state.supplied.length) {
    throw new Error('Foundry returned extra dice outcomes.');
  }

  const diceText = state.dice
    .map(
      (die) =>
        `${die.formula}: [${die.results
          .map((result) => (result.active ? result.result : `~${result.result}~`))
          .join(', ')}]`,
    )
    .join('; ');

  return {
    total,
    breakdown: `${diceText || parsed.normalizedFormula} = ${total}`,
    terms: state.terms,
    dice: state.dice,
    normalizedFormula: parsed.normalizedFormula,
  };
}

export function evaluateParsedDiceFormula(
  parsed: ParsedDiceFormula,
  rng: () => number = Math.random,
): DiceFormulaResult {
  return complete(parsed, { dice: [], terms: [], suppliedIndex: 0, rng });
}

export function evaluateDiceFormula(
  formula: string,
  rng: () => number = Math.random,
): DiceFormulaResult {
  return evaluateParsedDiceFormula(parseDiceFormula(formula), rng);
}

export function validateParsedDiceOutcomes(
  parsed: ParsedDiceFormula,
  dice: DiceOutcomes[],
): DiceFormulaResult {
  return complete(parsed, {
    dice: [],
    terms: [],
    supplied: dice,
    suppliedIndex: 0,
    rng: Math.random,
  });
}

export function validateDiceOutcomes(formula: string, dice: DiceOutcomes[]): DiceFormulaResult {
  return validateParsedDiceOutcomes(parseDiceFormula(formula), dice);
}
