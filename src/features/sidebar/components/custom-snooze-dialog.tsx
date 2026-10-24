// "Snooze ▸ Custom…": a date and time, or a duration.
//
// Opened imperatively — `requestCustomSnooze()` resolves with the chosen ISO
// instant, or `null` on cancel — so a menu item can await it after its menu
// has closed. One host, mounted once beside the sidebar, renders whichever
// request is open; a second request cancels the first. The arithmetic (and
// what counts as a valid future time) is `session-snooze.ts`'s.

import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import {
  customSnoozeUntil,
  localDate,
  localTime,
  type CustomSnooze,
} from "@/features/chat/lib/session-snooze";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Segmented } from "@/ui/segmented";
import { Select } from "@/ui/select";

type Request = { readonly resolve: (until: string | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Ask for a custom snooze time: the ISO instant, or `null` when cancelled. */
export function requestCustomSnooze(): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { resolve } }));
}

function finish(until: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(until);
}

export function CustomSnoozeDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <CustomSnoozeDialog /> : null;
}

type Unit = "minutes" | "hours" | "days";

const UNITS = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
] as const;

const MODES = [
  { value: "date", label: "Date and time" },
  { value: "duration", label: "Duration" },
] as const;

function CustomSnoozeDialog() {
  const id = useId();
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const [mode, setMode] = useState<CustomSnooze["mode"]>("date");
  const [date, setDate] = useState(() => localDate(initial));
  const [time, setTime] = useState(() => localTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<Unit>("hours");
  const [error, setError] = useState<string | null>(null);
  const input: CustomSnooze = mode === "date" ? { mode, date, time } : { mode, amount, unit };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogContent className="max-w-sm">
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const until = customSnoozeUntil(input, new Date());
            if (!until) {
              setError(
                mode === "date"
                  ? "Choose a valid date and time in the future."
                  : "Enter a positive duration.",
              );
              return;
            }
            finish(until);
          }}
        >
          <DialogHeader>
            <DialogTitle>Custom snooze</DialogTitle>
            <DialogDescription>Choose when the session comes back to your list.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Segmented
              aria-label="Schedule type"
              value={mode}
              options={MODES}
              onValueChange={(next) => {
                setMode(next);
                setError(null);
              }}
            />
            {mode === "date" ? (
              <div className="grid grid-cols-2 gap-3">
                <label
                  className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground"
                  htmlFor={`${id}-date`}
                >
                  Date
                  <Input
                    id={`${id}-date`}
                    type="date"
                    required
                    min={localDate(new Date())}
                    value={date}
                    onChange={(event) => {
                      setDate(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
                <label
                  className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground"
                  htmlFor={`${id}-time`}
                >
                  Time
                  <Input
                    id={`${id}-time`}
                    type="time"
                    required
                    value={time}
                    onChange={(event) => {
                      setTime(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label
                  className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground"
                  htmlFor={`${id}-amount`}
                >
                  Snooze for
                  <Input
                    id={`${id}-amount`}
                    type="number"
                    min={0}
                    step="any"
                    required
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
                <div className="flex min-w-0 flex-col gap-1.5 text-xs text-secondary-foreground">
                  Unit
                  <Select
                    aria-label="Unit"
                    className="w-full"
                    value={unit}
                    options={UNITS}
                    onValueChange={(next) => {
                      setUnit(next);
                      setError(null);
                    }}
                  />
                </div>
              </div>
            )}
            {error ? (
              <p role="alert" className="text-xs text-error">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Snooze</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
