Bug report — native agent session actor drops late assistant output.

In `crates/atlas-agents/src/actor.rs`, the session actor stamps every
incoming event with the turn epoch that produced it and drops events whose
stamp doesn't match the live turn. That guard exists so a cancelled or
superseded turn's stragglers can't contaminate the next turn's transcript.

But it currently also drops legitimate output: a turn that finishes
*normally* may have launched detached background work (for example a
delegate) that reports back after the prompt future resolves. Its assistant
output — text chunks stamped with the just-finished turn's epoch — belongs
in the session transcript, yet the actor throws it away because the turn is
no longer live.

Fix the actor so that:

- late assistant output stamped with a turn that completed **normally** is
  still applied to the session state and forwarded as deltas, and
- events stamped with a **cancelled or superseded** turn's epoch are still
  dropped exactly as before.

Run the `atlas-agents` crate's tests from `crates/atlas-agents/` to check
your work.
