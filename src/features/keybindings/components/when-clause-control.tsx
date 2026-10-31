/**
 * The "When" control under a keybinding's title, and the popover that edits
 * it: a text field for the expression and, below it, the same expression as a
 * tree of conditions and groups, on Atlas's primitives. There is no Save
 * step: a valid expression saves as it is typed or built, like every other
 * setting.
 */

import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, CircleX, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { Input } from "@/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Select } from "@/ui/select";
import { Hint } from "@/ui/tooltip";
import {
  DEFAULT_WHEN_VARIABLE,
  isKnownWhenVariable,
  parseWhen,
  parseWhenDraft,
  unknownWhenVariables,
  WHEN_SUGGESTIONS,
  WHEN_VARIABLE_DESCRIPTIONS,
  WHEN_VARIABLES,
  whenToExpression,
  type WhenNode,
} from "../lib/when";

type BooleanOperator = "and" | "or";

function flattenWhenChildren(node: WhenNode, operator: BooleanOperator): WhenNode[] {
  if (node.type !== operator) return [node];
  return [
    ...flattenWhenChildren(node.left, operator),
    ...flattenWhenChildren(node.right, operator),
  ];
}

function buildWhenExpressionGroup(
  children: readonly WhenNode[],
  operator: BooleanOperator,
): WhenNode | undefined {
  const first = children[0];
  if (!first) return undefined;
  return children
    .slice(1)
    .reduce<WhenNode>((left, right) => ({ type: operator, left, right }), first);
}

function conditionParts(node: WhenNode): { identifier: string; negated: boolean } | null {
  if (node.type === "identifier") return { identifier: node.name, negated: false };
  if (node.type === "not" && node.node.type === "identifier") {
    return { identifier: node.node.name, negated: true };
  }
  return null;
}

function setConditionIdentifier(node: WhenNode, identifier: string): WhenNode {
  const parts = conditionParts(node);
  if (!parts) return node;
  const next: WhenNode = { type: "identifier", name: identifier };
  return parts.negated ? { type: "not", node: next } : next;
}

function setConditionNegated(node: WhenNode, negated: boolean): WhenNode {
  const parts = conditionParts(node);
  if (!parts) return negated ? { type: "not", node } : node;
  const identifier: WhenNode = { type: "identifier", name: parts.identifier };
  return negated ? { type: "not", node: identifier } : identifier;
}

function defaultWhenCondition(): WhenNode {
  return { type: "identifier", name: DEFAULT_WHEN_VARIABLE };
}

function defaultWhenGroup(operator: BooleanOperator = "and"): WhenNode {
  return {
    type: operator,
    left: defaultWhenCondition(),
    // A second, different variable: the same one negated would make the
    // group always (or never) true.
    right: { type: "identifier", name: "inputFocus" },
  };
}

export function whenNodeRemoveLabel(node: WhenNode, depth: number): string {
  if (depth === 0) return "Clear all conditions";
  if (node.type === "identifier" || (node.type === "not" && node.node.type === "identifier")) {
    return "Remove condition";
  }
  return "Remove group and its conditions";
}

function WarningTooltipIcon({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Hint label={children}>
      <span
        tabIndex={0}
        aria-label={label}
        className="inline-flex size-control-xs shrink-0 items-center justify-center rounded text-warning outline-none"
      >
        <Icon icon={AlertTriangle} size="xs" />
      </span>
    </Hint>
  );
}

export function UnknownWhenVariableWarning({ identifiers }: { identifiers: readonly string[] }) {
  if (identifiers.length === 0) return null;
  const label =
    identifiers.length === 1
      ? `Unknown condition: ${identifiers[0]}`
      : `Unknown conditions: ${identifiers.join(", ")}`;
  return (
    <WarningTooltipIcon label={label}>
      {label}. Atlas doesn't provide it, so it is always false.
    </WarningTooltipIcon>
  );
}

function WhenVariableSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const options = WHEN_VARIABLES.includes(value) ? WHEN_VARIABLES : [value, ...WHEN_VARIABLES];
  return (
    <Select
      value={value}
      onValueChange={onChange}
      options={options.map((option) => ({
        value: option,
        label: option,
        description: WHEN_VARIABLE_DESCRIPTIONS[option] ?? "Not provided by Atlas",
      }))}
      size="sm"
      aria-label="Condition"
      className="min-w-0 flex-1"
    />
  );
}

function WhenExpressionRemoveButton({
  label,
  className,
  onRemove,
}: {
  label: string;
  className?: string;
  onRemove: () => void;
}) {
  return (
    <Hint label={label}>
      <Button variant="ghost" size="sm" aria-label={label} className={className} onClick={onRemove}>
        <Icon icon={Minus} size="xs" />
      </Button>
    </Hint>
  );
}

function NotToggle({
  pressed,
  label,
  onPressedChange,
}: {
  pressed: boolean;
  label: string;
  onPressedChange: (pressed: boolean) => void;
}) {
  return (
    <Button
      variant={pressed ? "outline" : "ghost"}
      size="sm"
      aria-pressed={pressed}
      aria-label={label}
      className="min-w-10"
      onClick={() => onPressedChange(!pressed)}
    >
      Not
    </Button>
  );
}

function WhenExpressionNodeEditor({
  node,
  depth = 0,
  onChange,
  onRemove,
}: {
  node: WhenNode;
  depth?: number;
  onChange: (node: WhenNode) => void;
  onRemove?: () => void;
}) {
  const condition = conditionParts(node);

  if (condition) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
        <NotToggle
          pressed={condition.negated}
          label={`Negate ${condition.identifier}`}
          onPressedChange={(pressed) => onChange(setConditionNegated(node, pressed))}
        />
        <WhenVariableSelect
          value={condition.identifier}
          onChange={(value) => onChange(setConditionIdentifier(node, value))}
        />
        {!isKnownWhenVariable(condition.identifier) && (
          <UnknownWhenVariableWarning identifiers={[condition.identifier]} />
        )}
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth)}
            onRemove={onRemove}
          />
        ) : null}
      </div>
    );
  }

  if (node.type === "not") {
    return (
      <div
        className={cn(
          "space-y-2 rounded-lg border border-border bg-element-hover p-2",
          depth > 0 && "bg-background",
        )}
      >
        <div className="flex items-center gap-2">
          <NotToggle
            pressed
            label="Negate group"
            onPressedChange={(pressed) => onChange(pressed ? node : node.node)}
          />
          {onRemove ? (
            <WhenExpressionRemoveButton
              label={whenNodeRemoveLabel(node, depth)}
              className="ml-auto"
              onRemove={onRemove}
            />
          ) : null}
        </div>
        <TreeBranch depth={depth}>
          <WhenExpressionNodeEditor
            node={node.node}
            depth={depth + 1}
            onChange={(next) => onChange({ type: "not", node: next })}
          />
        </TreeBranch>
      </div>
    );
  }

  const operator: BooleanOperator = node.type === "or" ? "or" : "and";
  const children = flattenWhenChildren(node, operator);
  const childKeyCounts = new Map<string, number>();
  const childEntries = children.map((child) => {
    const baseKey = `${child.type}-${whenToExpression(child)}`;
    const count = childKeyCounts.get(baseKey) ?? 0;
    childKeyCounts.set(baseKey, count + 1);
    return { child, key: count === 0 ? baseKey : `${baseKey}-${count}` };
  });

  const updateChild = (target: WhenNode, next: WhenNode) => {
    let didUpdate = false;
    const nextChildren = children.map((child) => {
      if (!didUpdate && child === target) {
        didUpdate = true;
        return next;
      }
      return child;
    });
    const nextNode = buildWhenExpressionGroup(nextChildren, operator);
    if (nextNode) onChange(nextNode);
  };

  const removeChild = (target: WhenNode) => {
    let didRemove = false;
    const nextChildren = children.filter((child) => {
      if (!didRemove && child === target) {
        didRemove = true;
        return false;
      }
      return true;
    });
    onChange(buildWhenExpressionGroup(nextChildren, operator) ?? defaultWhenCondition());
  };

  const setOperator = (nextOperator: BooleanOperator) => {
    if (nextOperator === operator) return;
    const nextNode = buildWhenExpressionGroup(children, nextOperator);
    if (nextNode) onChange(nextNode);
  };

  const addCondition = () => {
    const nextNode = buildWhenExpressionGroup([...children, defaultWhenCondition()], operator);
    if (nextNode) onChange(nextNode);
  };

  const addGroup = () => {
    const nestedOperator: BooleanOperator = operator === "and" ? "or" : "and";
    const nextNode = buildWhenExpressionGroup(
      [...children, defaultWhenGroup(nestedOperator)],
      operator,
    );
    if (nextNode) onChange(nextNode);
  };

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border border-border bg-element-hover p-2",
        depth > 0 && "bg-background",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={operator}
          onValueChange={setOperator}
          options={[
            { value: "and", label: "and" },
            { value: "or", label: "or" },
          ]}
          size="sm"
          aria-label="Operator"
          className="w-24"
        />
        <AddWhenMenu onCondition={addCondition} onGroup={addGroup} />
        {onRemove ? (
          <WhenExpressionRemoveButton
            label={whenNodeRemoveLabel(node, depth)}
            className="ml-auto"
            onRemove={onRemove}
          />
        ) : null}
      </div>
      <div className="space-y-2">
        {childEntries.map(({ child, key }) => (
          <TreeBranch key={key} depth={depth}>
            <WhenExpressionNodeEditor
              node={child}
              depth={depth + 1}
              onChange={(next) => updateChild(child, next)}
              onRemove={() => removeChild(child)}
            />
          </TreeBranch>
        ))}
      </div>
    </div>
  );
}

/**
 * The one way to grow an expression: a menu of the two things that can be
 * added, each saying what it is, rather than a pair of buttons repeated in
 * the header, the empty state and every group.
 */
function AddWhenMenu({
  label = "Add",
  onCondition,
  onGroup,
}: {
  label?: string;
  onCondition: () => void;
  onGroup: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm">
            <Icon icon={Plus} size="xs" />
            {label}
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={onCondition}>
          <span className="flex flex-col">
            <span>Condition</span>
            <span className="text-2xs text-muted-foreground">One variable, or its opposite</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onGroup}>
          <span className="flex flex-col">
            <span>Group</span>
            <span className="text-2xs text-muted-foreground">Conditions joined by and / or</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The guide line and elbow joining a child to its group. */
function TreeBranch({ depth, children }: { depth: number; children: ReactNode }) {
  const line = depth === 0 ? "bg-border-strong" : "bg-border";
  return (
    <div className="relative pl-4">
      <span className={cn("absolute top-0 bottom-0 left-1.5 w-px", line)} aria-hidden />
      <span className={cn("absolute top-4 left-1.5 h-px w-2.5", line)} aria-hidden />
      {children}
    </div>
  );
}

export function WhenExpressionBuilder({
  value,
  scope,
  onChange,
}: {
  value: WhenNode | undefined;
  /** Where the action runs regardless ("in the terminal"), for a
   *  panel-scoped one; empty for a global action. */
  scope?: string;
  onChange: (value: WhenNode | undefined) => void;
}) {
  const [expressionDraft, setExpressionDraft] = useState(() => whenToExpression(value));
  const parseResult = parseWhenDraft(expressionDraft);
  const parseError = parseResult.ok ? null : parseResult.message;
  const unknownIdentifiers = parseResult.ok ? unknownWhenVariables(parseResult.value) : [];

  const updateExpressionDraft = (nextExpression: string) => {
    setExpressionDraft(nextExpression);
    const nextResult = parseWhenDraft(nextExpression);
    if (nextResult.ok) onChange(nextResult.value);
  };

  const updateExpressionValue = (nextValue: WhenNode | undefined) => {
    setExpressionDraft(whenToExpression(nextValue));
    onChange(nextValue);
  };

  const addRootCondition = () => {
    if (!value) return updateExpressionValue(defaultWhenCondition());
    updateExpressionValue({ type: "and", left: value, right: defaultWhenCondition() });
  };

  const addRootGroup = () => {
    const group = defaultWhenGroup("or");
    if (!value) return updateExpressionValue(group);
    updateExpressionValue({ type: "and", left: value, right: group });
  };

  return (
    <div className="space-y-3">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <div className="text-sm font-medium text-foreground">When</div>
        {/* With nothing to build on yet, the empty state below carries these. */}
        {value && <AddWhenMenu onCondition={addRootCondition} onGroup={addRootGroup} />}
      </div>

      <div className="space-y-1.5">
        <div className="relative flex items-center">
          <Input
            value={expressionDraft}
            onChange={(event) => updateExpressionDraft(event.currentTarget.value)}
            placeholder="Always"
            aria-invalid={Boolean(parseError)}
            aria-label="When expression"
            size="sm"
            className="font-mono"
          />
          {unknownIdentifiers.length > 0 && (
            <span className="absolute right-1">
              <UnknownWhenVariableWarning identifiers={unknownIdentifiers} />
            </span>
          )}
        </div>
        {parseError ? (
          <div className="flex items-center gap-1.5 text-2xs text-error">
            <Icon icon={CircleX} size="xs" />
            {parseError}
          </div>
        ) : null}
      </div>

      <div className="relative">
        {value ? (
          <WhenExpressionNodeEditor
            node={value}
            onChange={updateExpressionValue}
            onRemove={() => updateExpressionValue(undefined)}
          />
        ) : (
          <div className="space-y-3 rounded-md border border-dashed border-border-strong p-3">
            <p className="text-xs text-muted-foreground">
              {scope
                ? `Runs whenever it can: ${scope.toLowerCase()}. Add a condition to narrow that.`
                : "Runs everywhere. Add a condition to limit where."}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {!scope &&
                WHEN_SUGGESTIONS.map((suggestion) => (
                  <Button
                    key={suggestion.expression}
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      updateExpressionValue(parseWhen(suggestion.expression) ?? undefined)
                    }
                  >
                    {suggestion.label}
                  </Button>
                ))}
              <AddWhenMenu
                label={scope ? "Add" : "Custom"}
                onCondition={addRootCondition}
                onGroup={addRootGroup}
              />
            </div>
          </div>
        )}
        {parseError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border border-destructive bg-background/75 p-4 text-center text-xs text-error backdrop-blur-xs">
            Fix the expression above to continue editing visually.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "When <expression> ⌄" under a row's title. `warning` is the row's own
 * caveat (a condition its panel can never meet), shown beside the trigger.
 */
export function WhenClauseControl({
  label,
  expression,
  value,
  warning,
  scope,
  onChange,
}: {
  label: string;
  expression: string;
  value: WhenNode | undefined;
  warning?: string | null;
  scope?: string;
  onChange: (value: WhenNode | undefined) => void;
}) {
  return (
    <span className="flex h-6 min-w-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <span className="text-xs leading-none text-muted-foreground">When</span>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Edit when clause for ${label}`}
              className="min-w-0 shrink"
            />
          }
        >
          <span className="truncate font-mono">{expression || "Always"}</span>
          <Icon icon={ChevronDown} size="xs" />
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-136 max-w-[calc(100vw-2rem)]">
          <WhenExpressionBuilder value={value} scope={scope} onChange={onChange} />
        </PopoverContent>
      </Popover>
      {warning && <WarningTooltipIcon label={warning}>{warning}</WarningTooltipIcon>}
    </span>
  );
}
