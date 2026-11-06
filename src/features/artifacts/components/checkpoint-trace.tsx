/**
 * The boundary to `@tryatlas/design`'s `CheckpointTrace` block: the gantt is
 * designed and built in the package, and the Timeline imports it, and its
 * types, from here only.
 *
 * Its own entry, like `./timeline-calendar`, because it needs the optional
 * `@tanstack/react-virtual` peer.
 */

export {
  CheckpointTrace,
  type CheckpointTraceProps,
  type TraceAuthor,
  type TraceCheckpoint,
  type TraceGroupBy,
  type TraceLabels,
  type TraceRange,
  type TraceSession,
  type TraceZoom,
} from "@tryatlas/design/checkpoint-trace";
