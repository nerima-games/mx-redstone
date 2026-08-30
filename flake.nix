{
  description = "mx-redstone: Experience module for the nerima-games Minecraft-clone rebuild: the redstone mechanism — wire power propagation, torches, levers, buttons, repeaters and piston pushing.";

  inputs = {
    # nixos-unstable, not nixpkgs-unstable: it advances only after the NixOS
    # release tests pass, so it is less likely to land a broken build.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      # Only what is actually exercised: x86_64-linux by CI, aarch64-darwin by
      # the maintainer. Declaring a platform nothing builds makes
      # `nix flake check --all-systems` fail rather than skip it.
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          # Node 24 matches the `engines` field and the CI runner. pnpm comes
          # from corepack rather than nixpkgs so that the version is decided by
          # the `packageManager` field in package.json — one source of truth
          # instead of two that can drift.
          #
          # oxlint and ast-grep are the opposite case: neither is a package.json
          # devDependency. oxlint used to be, and every repo in the org
          # independently drifted onto a different version without anyone
          # noticing. A single pinned Nix-provided oxlint/ast-grep is now the one
          # source of truth instead of 16 independently-drifting npm pins.
          #
          # nixpkgs is locked to a specific revision rather than tracking
          # nixos-unstable's HEAD: the current nixos-unstable ships oxlint
          # 1.79.0, whose `no-redeclare` rule falsely flags this repository's
          # `type X = ... & Brand` plus `const X = Brand.refined(...)` idiom
          # (A/B-proven against 1.75.0, which is clean). Re-check on the next
          # deliberate bump of this pin.
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.corepack_24
              pkgs.typescript-language-server
              pkgs.oxlint
              pkgs.ast-grep
            ];

            shellHook = ''
              corepackDir="$(mktemp -d "''${TMPDIR:-/tmp}/mx-redstone-corepack.XXXXXX")"
              corepack enable --install-directory "$corepackDir"
              export PATH="$corepackDir:$PATH"
            '';
          };
        }
      );
    };
}
