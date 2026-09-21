# Final merge review — decision training capture

Date: 2026-09-21. Reviewed branch: `feat/decision-training-capture` at `2629bb5ac0a763ee185ce9cd26a2f2dc62f7b30d`; target main: `c15ec5751f175335dbe3db2d12aff6e62ac8785a`.

## Scope and preserved implementation

The merge includes the existing Jev/Laya provider implementation, optional official Python worker, Decision/Outcome/Evaluation capture, purpose-specific evidence evaluation, immutable raw event storage, reproducible canonical datasets and isolated Laya exports. The pre-existing key-storage regression fix is retained. No runtime credentials, production settings, provider/capture switches or user worktree files are changed by this GitHub merge.

## Additional pre-merge corrections

1. Explicit tests/build/lint/typecheck/artifact failure and serious review findings cannot be counted as downstream success merely because the broad task flag or another check reports success. Conflicts are recorded as `CONTRADICTORY_OUTCOME_EVIDENCE`; unknown metrics remain unknown.
2. The public evaluator enforces matching decision IDs even when called directly without the store index. An unrelated outcome cannot create quality evidence or labels.
3. A passing and failing required assertion referencing the same question/evidence cannot manufacture a ground-truth label. Independent human corrections and valid question-specific assertions remain distinct from generic task success.
4. Evaluation enforcement is identified by `implementation_revision=evidence-guards-v1`, alongside the unchanged label policy `downstream-evidence-v2`. Derived evaluations and the complete dataset manifest policy carry this revision. Dataset versions hash that policy; old raw evidence and existing dataset versions are not overwritten.

## Verification required before merge

The repository CI on the exact reviewed branch and again on the merged main commit must run: JavaScript syntax checks, the complete Node test suite including `training-finalization.test.mjs`, Python worker boundary tests, offline smoke, fast-path demo, classifier demo, and the decision-to-outcome-to-dataset-to-Laya-export demo. The final check rejects generated data or source changes left in the checkout. The four runners are macOS/Linux with Node 22/24. CI logs, not these planned commands, establish the result.

The added regression suite covers explicit quality failures, unknown evidence, wrong decision joins, conflicting label assertions, weak host reports, preference/success-count exclusion, and manifest/evaluation revision reproducibility.

## Runtime boundary

Capture stays OFF by default and separate from operational telemetry. No provider majority voting, online learning, automatic checkpoint promotion, provider fallback chain or host permission bypass is added. API keys remain outside source and datasets. Only the configured provider affects an active decision; shadow comparisons are not counterfactual downstream executions.

User Mac inspection was attempted, but no remote device was connected. No local uncommitted work was read, overwritten or claimed synchronized. This review uses the saved GitHub branch. Live TypeSafe credentials, an actual Laya model/MPS run and native Codex/Claude sessions are separate integration checks; offline CI does not claim those results or model quality gains. Offline fine-tuning and deployment remain explicitly out of scope.
