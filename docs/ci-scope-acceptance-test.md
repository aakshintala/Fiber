# CI scope acceptance test (throwaway)

Live verification for #62/#101: this PR touches only this file, so CI
should run scope + shellcheck + static gates and skip everything heavy,
in both draft and ready scope. Never merge; close unmerged.
