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
          # Node 22 matches the `engines` field and the CI runner. pnpm comes
          # from corepack rather than nixpkgs so that the version is decided by
          # the `packageManager` field in package.json — one source of truth
          # instead of two that can drift.
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.corepack_22
              pkgs.typescript-language-server
            ];

            shellHook = ''
              corepack enable --install-directory "$PWD/.corepack" 2>/dev/null || true
              export PATH="$PWD/.corepack:$PATH"
            '';
          };
        }
      );
    };
}
