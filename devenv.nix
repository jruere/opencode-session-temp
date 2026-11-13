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
  # Formatter and linter for TypeScript, JavaScript, and JSON.
  packages = [ pkgs.biome ];

  # https://devenv.sh/tests/
  # `devenv test` runs this and the git hooks. Node 24 runs TypeScript tests directly.
  enterTest = ''
    node --test
  '';

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
