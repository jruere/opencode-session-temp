{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:

{
  # https://devenv.sh/languages/
  ## Node.js runtime and npm for the plugin, its dependencies, and its tests.
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    lsp.enable = false;
    npm.enable = true;
  };
  ## tsc and the TypeScript language server.
  languages.typescript.enable = true;

  # https://devenv.sh/packages/
  packages = [
    pkgs.biome # Formatter and linter for TypeScript, JavaScript, and JSON.
    pkgs.mcp-language-server # LSP-to-MCP adapter for agent.
  ];

  # https://devenv.sh/tasks/
  # Keep these tasks in sync with the package.json scripts: same commands, globs, and
  # coverage thresholds. `devenv test` runs test:typecheck and test:unit because both
  # run before devenv:enterTest.
  tasks = {
    "npm:install" = {
      exec = "npm ci --no-audit --no-fund";
      # Run after shell setup so the task sees the environment exports. `devenv tasks
      # run` does not enter the shell automatically.
      after = [ "devenv:enterShell" ];
      # Skip only when node_modules exists and is not older than the lockfile; an
      # unconditional `npm ci` would reinstall on every run.
      status = "[ -f node_modules/.package-lock.json ] && [ ! package-lock.json -nt node_modules/.package-lock.json ]";
    };

    "test:typecheck" = {
      exec = "tsc --noEmit";
      # npm:install brings enterShell. `devenv test` selects the git hooks separately;
      # tests do not wait for them.
      after = [ "npm:install" ];
      before = [ "devenv:enterTest" ];
    };

    "test:unit" = {
      exec = "node --test 'test/**/*.test.ts'";
      # npm:install brings enterShell. `devenv test` selects the git hooks separately;
      # tests do not wait for them.
      after = [ "npm:install" ];
      before = [ "devenv:enterTest" ];
    };

    "test:live" = {
      exec = "node --test 'test/live/*.live.ts'";
      after = [ "npm:install" ];
    };

    "test:coverage" = {
      exec = "node --test --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-lines=80 --test-coverage-functions=80 --test-coverage-branches=80 'test/**/*.test.ts'";
      after = [ "npm:install" ];
    };
  };

  # https://devenv.sh/git-hooks/
  git-hooks.hooks = {
    # Standard checks.
    check-added-large-files.enable = true;
    check-json.enable = true;
    check-symlinks.enable = true;
    check-yaml.enable = true;
    end-of-file-fixer.enable = true;
    markdownlint = {
      enable = true;
      # README uses long lines and unlabelled diagrams.
      args = [ "--disable" "MD013,MD040" ];
    };
    yamlfmt.enable = true;

    # TypeScript, JavaScript, JSON.
    biome.enable = true;
  };

  # See full reference at https://devenv.sh/reference/options/
}
