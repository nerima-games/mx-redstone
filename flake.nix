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
          # oxlint is the opposite case: it is NOT a package.json devDependency.
          # It used to be, and every repo in the org independently drifted onto
          # a different version without anyone noticing. A single pinned
          # Nix-provided oxlint is now the one source of truth instead of 16
          # independently-drifting npm pins.
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.corepack_24
              pkgs.typescript-language-server
              pkgs.oxlint
            ];

            shellHook = ''
              mkdir -p "$PWD/.corepack"
              corepack enable --install-directory "$PWD/.corepack"
              export PATH="$PWD/.corepack:$PATH"
            '';
          };
        }
      );
    };
}
