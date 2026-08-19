In `TELEMETRY.md`, the opening guarantee was watered down by mistake.
Restore it exactly. Change

> If something is missing from the table below, Atlas may still send it. If you find
> something that contradicts this file, that is expected while telemetry stabilises.

back to

> If something is not in the table below, Atlas does not send it. If you find something
> that contradicts this file, that is a bug — please open an issue.

The replacement must reproduce the original line breaks exactly as shown
(the first line ends after "send it. If you find something"). Change
nothing else in the repository.
