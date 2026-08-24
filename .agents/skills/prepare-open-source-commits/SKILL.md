---
name: prepare-open-source-commits
description: Audit a Git repository for secrets, personal data, local configuration, and private decision notes, then split the intended public change into small reviewable commits. Use when asked to prepare, stage, commit, or review changes for an open-source repository, especially when unpushed commits or a dirty worktree may contain credentials, deployment identifiers, private ADRs, or other machine- or maintainer-specific data.
metadata:
  internal: true
---

# Prepare open-source commits

Create a public history, not merely a clean working tree. Inspect every layer
that could be pushed: commits ahead of the upstream branch, the index, tracked
working-tree changes, and untracked files.

## 1. Establish the public boundary

1. Read repository instructions and ignore rules.
2. Inspect `git status --short --branch`, the upstream divergence, and the full
   diff from upstream through the working tree.
3. List ignored or private paths by name only. Do not print the contents of
   credential stores, environment files, local state, logs, or private notes.
4. Determine which changes are intended for the public repository. Do not infer
   that an ignored file is safe merely because it is related to the task.

Treat these as private unless the repository explicitly defines a portable
placeholder or the user explicitly approves publication:

- API keys, tokens, passwords, cookies, private keys, and signed URLs;
- cloud account, zone, database, bucket, tenant, and deployment identifiers;
- personal email addresses, domains, usernames, absolute paths, and hostnames;
- customer data, message contents, production logs, and local tool state;
- private planning documents, architecture decision records, and design notes.

Public author attribution and documented project URLs can be legitimate. Verify
that they are intentional project metadata instead of assuming that every name
or URL is either private or safe.

## 2. Scan without disclosing findings

Prefer a repository-approved secret scanner. Also inspect added lines for
credential formats, high-entropy literals assigned to sensitive fields, UUIDs
in deployment configuration, non-example email addresses and domains, and
absolute user paths. Report the file and category while redacting the value.

Search file names and added text for ADR or decision-record markers and for
unexpected natural-language text, including Han characters. Translation files
and localized documentation may be intentionally public; local planning or
decision prose is not. Classify by purpose and path rather than deleting all
non-English content.

Repeat the scan over:

1. the upstream-to-`HEAD` commit range;
2. the staged diff;
3. unstaged tracked changes;
4. untracked, non-ignored files.

If a suspicious literal cannot be classified confidently, leave it uncommitted
and ask. Never paste a possible secret into a commit message or diagnostic.

## 3. Design the commit series

Group by one reviewable purpose and order dependencies from lower to higher
layers. Typical boundaries are contract or schema, domain behavior, adapters,
API or CLI surfaces, UI, tests, and documentation. Keep a test with the behavior
it proves when practical.

Avoid a mechanical one-commit-per-directory split when files implement one
cross-layer behavior. Avoid mixing unrelated cleanup, generated artifacts, or
personal configuration into a feature commit.

For an existing unpushed aggregate commit, preserve its tree, move the branch
back to the upstream base without discarding working files, and rebuild the
series. Do not rewrite commits that may already be shared without explicit
authorization.

## 4. Stage and commit narrowly

1. Stage explicit paths or selected hunks. Do not use `git add .` or
   `git add -A` in a repository with private local state.
2. Review `git diff --cached --stat`, `git diff --cached --check`, and the full
   staged patch.
3. Run the smallest relevant validation for that group.
4. Commit with an imperative message that describes the public behavior.
5. Inspect the resulting commit and rerun the privacy scan before continuing.

Generated lockfiles or migration journals belong with the change that generated
them. A known local deployment value must be replaced by the repository's
portable placeholder before staging.

## 5. Verify the push candidate

After the final commit:

- inspect the complete upstream-to-`HEAD` file list and diff summary;
- rerun secret, personal-data, unexpected-language, and ADR checks;
- run the repository's proportional test, typecheck, lint, or build commands;
- confirm the working tree contains only expected local or ignored state;
- summarize the commit order and any deliberately excluded local files.

Do not push unless the user explicitly requested it.

## Recovery rules

- If sensitive data is unstaged or staged, remove it from the public change and
  restore a placeholder without echoing the value.
- If it exists only in unpushed commits, rewrite those commits and verify the
  unreachable content is not in the push range.
- If it was pushed, stop. Deleting it in a later commit is insufficient. Tell
  the user to revoke or rotate the credential first, then coordinate history
  removal appropriate to the hosting service.
