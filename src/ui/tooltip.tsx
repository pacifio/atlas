import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import * as React from "react";

import { cn } from "@/lib/utils";
import {
  isTooltipWarm,
  markTooltipClosed,
  markTooltipOpen,
  TOOLTIP_CLOSE_DELAY,
  TOOLTIP_OPEN_DELAY,
  TOOLTIP_WARM_WINDOW,
} from "@/ui/tooltip-timing";

/**
 * Border-arrow tooltip (user-supplied Skiper design, adapted to Atlas):
 * shadcn-style token classes swapped for house tokens, `animate-in` (a
 * tailwindcss-animate utility this repo does not ship) swapped for the house
 * `animate-scale-in`, and the arrow SVG's `--color-*` vars bound inline so
 * the notch matches the panel fill and hairline exactly.
 *
 * Built on `@base-ui/react/tooltip`. Shaped like shadcn's base-style tooltip —
 * `Portal > Positioner > Popup`, positioning props declared on the content
 * wrapper and forwarded to the Positioner — with Atlas's own timing layered on
 * top (see `Tooltip` below).
 */
const HasProvider = React.createContext(false);

/**
 * Base UI names the shared delay `delay` (Radix: `delayDuration`) and the
 * skip-delay window `timeout` (Radix: `skipDelayDuration`). Both live on the
 * Provider; Base UI has no delay prop on the Root at all — a per-tooltip
 * override goes on the Trigger.
 */
function TooltipProvider({
  delay = TOOLTIP_OPEN_DELAY,
  timeout = TOOLTIP_WARM_WINDOW,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <HasProvider.Provider value={true}>
      <TooltipPrimitive.Provider delay={delay} timeout={timeout} {...props} />
    </HasProvider.Provider>
  );
}

interface TimingContext {
  /** True when this tooltip opened straight after another: skip the entrance. */
  instant: boolean;
  /** Drop an open that is still waiting out the delay. */
  cancelPending: () => void;
  /** True while `tooltip-timing.ts` — not Base UI — owns the open delay. */
  managed: boolean;
  open: boolean;
  contentId?: string;
  setContentId: (id: string | undefined) => void;
}
const Timing = React.createContext<TimingContext>({
  instant: false,
  cancelPending: () => {},
  managed: false,
  open: false,
  setContentId: () => {},
});

type TooltipProps = Omit<TooltipPrimitive.Root.Props, "onOpenChange"> & {
  onOpenChange?: (open: boolean, eventDetails?: TooltipPrimitive.Root.ChangeEventDetails) => void;
  /**
   * Override the shared open delay for this tooltip. Was `delayDuration` on the
   * Radix wrapper; Base UI spells the same idea `delay` (and puts it on the
   * Trigger, which is where this ends up when Atlas is not managing timing).
   */
  delay?: number;
};

/**
 * Wraps itself in a provider only when none is mounted above, so a
 * `<Tooltip>` works anywhere without setup. Base UI reads the NEAREST
 * provider, so wrapping unconditionally would give every tooltip a skip-delay
 * group of its own.
 *
 * Uncontrolled tooltips take their timing from `tooltip-timing.ts` instead of
 * Base UI's provider: the trigger is told to open at once (`delay={0}`) and
 * this component applies the shared delay, so the skip-delay window also
 * spans `HintGroup` and the titlebar dock. A controlled tooltip (`open`
 * passed) is left entirely to its owner.
 */
function Tooltip({ open: openProp, defaultOpen, onOpenChange, delay, ...props }: TooltipProps) {
  const controlled = openProp !== undefined;
  const [open, setOpen] = React.useState(defaultOpen ?? false);
  const [instant, setInstant] = React.useState(false);
  const [contentId, setContentId] = React.useState<string>();
  const openRef = React.useRef(open);
  openRef.current = open;
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  // An unmount while open must not leave the shared state warm forever.
  React.useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (openRef.current) markTooltipClosed();
    },
    [],
  );

  const handleOpenChange = React.useCallback(
    (next: boolean, eventDetails?: TooltipPrimitive.Root.ChangeEventDetails) => {
      clearTimeout(timer.current);
      if (!next) {
        if (openRef.current) markTooltipClosed();
        openRef.current = false;
        setOpen(false);
        onOpenChange?.(false, eventDetails);
        return;
      }
      if (openRef.current) return;
      const show = (warm: boolean) => {
        markTooltipOpen();
        openRef.current = true;
        setInstant(warm);
        setOpen(true);
        onOpenChange?.(true, eventDetails);
      };
      const wait = delay ?? TOOLTIP_OPEN_DELAY;
      if (eventDetails?.reason === "trigger-focus" || isTooltipWarm() || wait === 0) {
        show(isTooltipWarm());
      } else timer.current = setTimeout(() => show(false), wait);
    },
    [delay, onOpenChange],
  );

  const cancelPending = React.useCallback(() => clearTimeout(timer.current), []);
  const timing = React.useMemo(
    () => ({
      instant,
      cancelPending,
      managed: !controlled,
      open: openProp ?? open,
      contentId,
      setContentId,
    }),
    [instant, cancelPending, controlled, openProp, open, contentId],
  );

  const root = (
    <Timing.Provider value={timing}>
      <TooltipPrimitive.Root
        open={openProp ?? open}
        onOpenChange={controlled ? onOpenChange : handleOpenChange}
        {...props}
      />
    </Timing.Provider>
  );
  return React.useContext(HasProvider) ? root : <TooltipProvider>{root}</TooltipProvider>;
}

/**
 * While the delay runs, Base UI is held at `open={false}`, so leaving the
 * trigger changes nothing Base UI knows about and it never reports a close.
 * The trigger cancels the pending open itself on leave, blur and press.
 *
 * `delay={0}` hands the wait to `tooltip-timing.ts`; Base UI's own per-trigger
 * default is 600ms and its provider delay would otherwise apply twice.
 */
function TooltipTrigger({
  onPointerLeave,
  onBlur,
  onPointerDown,
  delay,
  closeDelay = TOOLTIP_CLOSE_DELAY,
  ...props
}: TooltipPrimitive.Trigger.Props) {
  const { cancelPending, managed, open, contentId } = React.useContext(Timing);
  const element = React.isValidElement<TriggerProps>(props.render) ? props.render : null;
  const describedBy =
    [
      ...new Set(
        [
          props["aria-describedby"],
          element?.props["aria-describedby"],
          open ? contentId : undefined,
        ].flatMap((id) => id?.split(/\s+/) ?? []),
      ),
    ].join(" ") || undefined;
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      delay={managed ? 0 : delay}
      closeDelay={closeDelay}
      onPointerLeave={(e) => {
        cancelPending();
        onPointerLeave?.(e);
      }}
      onBlur={(e) => {
        cancelPending();
        onBlur?.(e);
      }}
      onPointerDown={(e) => {
        cancelPending();
        onPointerDown?.(e);
      }}
      {...props}
      render={
        element ? React.cloneElement(element, { "aria-describedby": describedBy }) : props.render
      }
      aria-describedby={describedBy}
    />
  );
}

type Side = TooltipPrimitive.Positioner.Props["side"];
type Align = TooltipPrimitive.Positioner.Props["align"];

/**
 * Radix's `Popper.Arrow` rotated the notch itself; Base UI's Arrow only sets
 * `position`, and the cross-axis `top`/`left` the floating-ui middleware
 * computed. The main-axis offset, the rotation and the origin it turns about
 * are restated here with exactly the values Radix used, so the notch lands in
 * the same place on every side.
 */
const ARROW_OFFSET = {
  top: { bottom: 0, transform: "translateY(100%)" },
  bottom: { top: 0, transformOrigin: "center 0", transform: "rotate(180deg)" },
  right: {
    left: 0,
    transformOrigin: "0 0",
    transform: "translateY(50%) rotate(90deg) translateX(-50%)",
  },
  left: {
    right: 0,
    transformOrigin: "100% 0",
    transform: "translateY(50%) rotate(-90deg) translateX(50%)",
  },
} satisfies Record<string, React.CSSProperties>;

function arrowStyle(side: string): React.CSSProperties {
  if (side === "inline-start") return ARROW_OFFSET.left;
  if (side === "inline-end") return ARROW_OFFSET.right;
  return ARROW_OFFSET[side as keyof typeof ARROW_OFFSET] ?? ARROW_OFFSET.top;
}

/**
 * The positioning props are declared here and forwarded to the Positioner.
 * Left in `...props` they would land on the Popup — the wrong DOM node — and
 * positioning would silently stop working.
 */
function TooltipContent({
  id: idProp,
  className,
  side = "top",
  sideOffset = 0,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  const { instant, open, setContentId } = React.useContext(Timing);
  const generatedId = React.useId();
  const id = idProp ?? generatedId;
  React.useLayoutEffect(() => {
    setContentId(id);
    return () => setContentId(undefined);
  }, [id, setContentId]);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side as Side}
        sideOffset={sideOffset}
        align={align as Align}
        alignOffset={alignOffset}
        className="isolate z-tooltip"
      >
        <TooltipPrimitive.Popup
          id={id}
          role="tooltip"
          aria-hidden={!open}
          data-slot="tooltip-content"
          style={
            {
              "--color-background": "var(--popover)",
              "--color-border": "var(--border)",
            } as React.CSSProperties
          }
          className={cn(
            "group w-fit text-balance rounded-md px-2.5 py-1 text-xs",
            "bg-[var(--popover)] text-foreground",
            "outline outline-1 outline-[var(--border)]",
            "animate-scale-in origin-[var(--transform-origin)]",
            instant && "animate-none",
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow
            data-slot="tooltip-arrow"
            style={(state) => arrowStyle(state.side)}
          >
            <ArrowSvg />
          </TooltipPrimitive.Arrow>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

type TriggerProps = Record<string, unknown> & {
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
};

export function isFocusVisible(el: EventTarget) {
  try {
    return el instanceof Element && el.matches(":focus-visible");
  } catch {
    // Engines without the selector: treat every focus as keyboard focus.
    return true;
  }
}

/**
 * Props for the element a hint wraps. The tooltip does not name its trigger
 * (`TooltipTrigger` adds `aria-describedby` while it is open), so a string label
 * becomes the `aria-label` unless the element already has a name. The native
 * `title` is dropped: it would open a second, unstyled tooltip on top.
 *
 * A `title` set on an inner element (e.g. a button inside a menu trigger's
 * `render`) is out of reach here — remove it at the source.
 */
export function hintTriggerProps(
  props: TriggerProps,
  label: React.ReactNode,
  descriptionId?: string,
) {
  const named = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
  return {
    title: undefined,
    "aria-label": named || typeof label !== "string" ? props["aria-label"] : label,
    "aria-describedby":
      [props["aria-describedby"], descriptionId].filter(Boolean).join(" ") || undefined,
  };
}

/**
 * The tooltip for one icon-only control:
 *
 *   <Hint label="Refresh"><button onClick={refresh}><RefreshCw /></button></Hint>
 *
 * A disabled control fires no pointer events, so its tooltip could never
 * open. When the child has a `disabled` prop at all, the trigger is a wrapping
 * span instead. The check is on the prop being present rather than true so
 * the DOM shape does not change (and focus is not lost) when it toggles.
 * Pass `wrap={false}` where the extra span would break the layout.
 */
function Hint({
  label,
  shortcut,
  side = "bottom",
  align,
  sideOffset = 4,
  wrap,
  children,
}: {
  label: React.ReactNode;
  /** Keys shown dimmed after the label, e.g. "⌘K". */
  shortcut?: React.ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  wrap?: boolean;
  children: React.ReactElement;
}) {
  const child = React.Children.only(children) as React.ReactElement<TriggerProps>;
  const trigger = React.cloneElement(child, hintTriggerProps(child.props, label));
  const shouldWrap = wrap ?? child.props.disabled !== undefined;

  return (
    <Tooltip>
      {/*
        Base UI only opens on focus when the trigger matches `:focus-visible`,
        so the programmatic focus a dialog gives its first control no longer
        needs the `openOnKeyboardFocusOnly` guard the Radix wrapper carried.
      */}
      <HintTarget trigger={trigger} wrap={shouldWrap} />
      <TooltipContent side={side} align={align} sideOffset={sideOffset}>
        {label}
        {shortcut != null && <span className="ml-1.5 text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** A disabled-capable wrapper must describe the real button as well as the hover target. */
function HintTarget({
  trigger,
  wrap,
}: {
  trigger: React.ReactElement<TriggerProps>;
  wrap: boolean;
}) {
  const { open, contentId } = React.useContext(Timing);
  const described = React.cloneElement(
    trigger,
    hintTriggerProps(trigger.props, undefined, open ? contentId : undefined),
  );
  return (
    <TooltipTrigger
      render={
        wrap ? (
          <span className="inline-flex [&>:disabled]:pointer-events-none">{described}</span>
        ) : (
          described
        )
      }
    />
  );
}

export { Hint, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };

const ArrowSvg = (props: React.ComponentProps<"svg">) => (
  <svg
    width="20"
    height="10"
    viewBox="0 0 20 10"
    fill="none"
    className="ml-[1px] mt-[-1px]"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M10.3356 7.39793L15.1924 3.02682C15.9269 2.36577 16.8801 2 17.8683 2H20V0H0V2H1.4651C2.4532 2 3.4064 2.36577 4.1409 3.02682L8.9977 7.39793C9.378 7.7402 9.9553 7.74021 10.3356 7.39793Z"
      fill="var(--color-background)"
    />
    <path d="M11.1363 8.14124C10.3757 8.82575 9.22111 8.82578 8.46041 8.14122L3.60361 3.77011C3.05281 3.27432 2.33791 2.99999 1.59681 2.99999L4.24171 3L9.12941 7.39793C9.50971 7.7402 10.087 7.7402 10.4674 7.39793L15.3544 3L18 2.99999C17.2589 2.99999 16.544 3.27432 15.9931 3.77011L11.1363 8.14124Z" />
    <path
      d="M9.6667 6.65461L14.5235 2.28352C15.4416 1.45721 16.6331 1 17.8683 1H20V2H17.8683C16.8801 2 15.9269 2.36577 15.1924 3.02682L10.3356 7.39793C9.9553 7.74021 9.378 7.7402 8.9977 7.39793L4.1409 3.02682C3.4064 2.36577 2.4532 2 1.4651 2H0V1H1.4651C2.7002 1 3.8917 1.45722 4.8099 2.28352L9.6667 6.65461Z"
      fill="var(--color-border)"
    />
  </svg>
);
