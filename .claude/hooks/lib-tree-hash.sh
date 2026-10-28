#!/bin/sh
# lib-tree-hash.sh — shared content hash of the working tree.
#
# Sourced by run-verify.sh (writes the marker) and pre-push-gate.sh (checks
# it). The hash must be identical for identical CONTENT regardless of commit
# or staging state, so that `verify → commit → push` passes the gate without
# re-running the suite, while any content edit after verification invalidates
# the marker.
#
# Implementation: overlay the working tree onto a THROWAWAY index
# (GIT_INDEX_FILE) and `git write-tree` it. Tracked + untracked files are
# included, .gitignore is respected, submodules hash as their gitlink SHA.
# The real index, HEAD, and working tree are never touched. Object writes go
# to a THROWAWAY object dir (GIT_OBJECT_DIRECTORY) with the real store as a
# read alternate, so no dangling loose objects are left in .git/objects; the
# write-tree SHA is content-addressed, hence unchanged by this indirection.

tree_state_hash() {
  _repo_root=$(git rev-parse --show-toplevel) || return 1
  # The SHARED object store — NOT "$_repo_root/.git/objects". In a linked
  # worktree `.git` is a FILE ("gitdir: …/.git/worktrees/<name>"), so that
  # path does not exist, read-tree failed, and the whole gate aborted with
  # "could not hash the working tree" — making `yarn verify:push`, and
  # therefore every gated push, impossible from any worktree.
  # `--git-common-dir` resolves to the real store in both layouts. Ask from
  # $_repo_root so a relative answer (plain ".git" in a normal checkout) is
  # relative to a known directory rather than $PWD.
  _common_dir=$(git -C "$_repo_root" rev-parse --git-common-dir) || return 1
  case "$_common_dir" in
    /*) ;;
    *) _common_dir="$_repo_root/$_common_dir" ;;
  esac
  _tmp_index=$(mktemp "${TMPDIR:-/tmp}/usemoney-verify-index.XXXXXX") || return 1
  # `git add -A` writes real loose blobs/trees; against the default store
  # they would be left DANGLING in .git/objects once the temp index is
  # deleted (2x per verify run, 1x per gated push). Route writes to a
  # throwaway object dir; the alternate lets already-stored content resolve
  # from the real store without copying. Env is per-invocation on purpose —
  # exporting would poison later git calls in the sourcing script.
  _tmp_objects=$(mktemp -d "${TMPDIR:-/tmp}/usemoney-verify-objects.XXXXXX") || {
    rm -f "$_tmp_index"
    return 1
  }
  if ! GIT_INDEX_FILE="$_tmp_index" GIT_OBJECT_DIRECTORY="$_tmp_objects" \
    GIT_ALTERNATE_OBJECT_DIRECTORIES="$_common_dir/objects" \
    git -C "$_repo_root" read-tree HEAD >/dev/null 2>&1; then
    rm -rf "$_tmp_index" "$_tmp_objects"
    return 1
  fi
  if ! GIT_INDEX_FILE="$_tmp_index" GIT_OBJECT_DIRECTORY="$_tmp_objects" \
    GIT_ALTERNATE_OBJECT_DIRECTORIES="$_common_dir/objects" \
    git -C "$_repo_root" add -A >/dev/null 2>&1; then
    rm -rf "$_tmp_index" "$_tmp_objects"
    return 1
  fi
  GIT_INDEX_FILE="$_tmp_index" GIT_OBJECT_DIRECTORY="$_tmp_objects" \
    GIT_ALTERNATE_OBJECT_DIRECTORIES="$_common_dir/objects" \
    git -C "$_repo_root" write-tree
  _status=$?
  rm -rf "$_tmp_index" "$_tmp_objects"
  return $_status
}

# Marker location (repo-root relative). Gitignored — verification state is
# per-machine, never shared.
verify_marker_path() {
  printf '%s/.claude/.verify-ok' "$(git rev-parse --show-toplevel)"
}
