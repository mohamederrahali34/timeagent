# Contributing

TimeAgent is an experimental project. Keep changes focused and avoid weakening checkpoint validation or restoration tests.

## Setup

```sh
npm install
npm run build
npm test
```

Pull requests should explain the user-visible behavior, include regression tests for bug fixes, and keep `run`, `diff`, `status`, and `undo` behavior compatible unless a breaking change is intentional and documented.
