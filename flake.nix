{
  description = "Repro: Patchwork nodes sharing one Subduction identity lose each other's ephemeral subscriptions";

  inputs = {
    patchwork-system.url = "github:inkandswitch/patchwork-system";
    # Same nixpkgs as Patchwork, so playwright-driver matches @playwright/test.
    nixpkgs.follows = "patchwork-system/nixpkgs";
    subduction.url = "github:inkandswitch/subduction";
  };

  outputs =
    { nixpkgs, subduction, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        system: pkgs: {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm
              subduction.packages.${system}.subduction_cli
            ];
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          };
        }
      );
    };
}
