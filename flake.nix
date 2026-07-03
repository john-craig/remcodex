{
  description = "RemCodex with local Whisper transcription support";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;
        nodejs = pkgs.nodejs_20;
        whisperModelTiny = pkgs.runCommand "faster-whisper-tiny-en" { } ''
          mkdir -p $out
          cp ${pkgs.fetchurl {
            url = "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/main/model.bin";
            sha256 = "0akbjc75br4jakamgb92l17fw461bjz7i7csbjbirfaddbhglnhs";
          }} $out/model.bin
          cp ${pkgs.fetchurl {
            url = "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/main/config.json";
            sha256 = "1ibwd97kijpjci44r7nb9508f6jndd1625483davqj83m4hv9c8l";
          }} $out/config.json
          cp ${pkgs.fetchurl {
            url = "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/main/tokenizer.json";
            sha256 = "1pr25px1bnafw3j29qyqf38k5qdmpjmx2xcanghxqdll8195574j";
          }} $out/tokenizer.json
          cp ${pkgs.fetchurl {
            url = "https://huggingface.co/Systran/faster-whisper-tiny.en/resolve/main/vocabulary.txt";
            sha256 = "1kqml5svagpwcv5k6xf5392f4p5rszznjnxb69fmk8nk8s3mhxzz";
          }} $out/vocabulary.txt
        '';
        remcodex = pkgs.buildNpmPackage rec {
          pname = "remcodex";
          version = "0.1.0-beta.12";
          src = self;

          inherit nodejs;
          npmDepsHash = "sha256-JjTjD2OBS355hufnvwI/akpGtdAcGHTT2zSet+4k9Os=";

          nativeBuildInputs = [
            pkgs.makeWrapper
            nodejs
            pkgs.pkg-config
            pkgs.python3
          ];

          npmBuildScript = "build";
          doCheck = false;

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/remcodex
            cp -r dist $out/lib/remcodex/dist
            cp -r node_modules $out/lib/remcodex/node_modules
            cp -r web $out/lib/remcodex/web
            cp package.json package-lock.json README.md LICENSE $out/lib/remcodex/

            makeWrapper ${nodejs}/bin/node $out/bin/remcodex \
              --add-flags $out/lib/remcodex/dist/server/src/cli.js

            runHook postInstall
          '';

          meta = with lib; {
            description = "Remote control for Codex from a browser or phone";
            homepage = "https://remcodex.com";
            license = licenses.mit;
            platforms = platforms.unix;
            mainProgram = "remcodex";
          };
        };
        remcodex-with-whisper = pkgs.symlinkJoin {
          name = "remcodex-with-whisper-${remcodex.version}";
          paths = [ remcodex ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/remcodex \
              --prefix PATH : ${lib.makeBinPath [ nodejs pkgs.whisper-ctranslate2 pkgs.ffmpeg ]} \
              --set-default REMCODEX_STT_BINARY ${pkgs.whisper-ctranslate2}/bin/whisper-ctranslate2 \
              --set-default REMCODEX_STT_MODEL_PATH ${whisperModelTiny}
          '';
          meta = remcodex.meta // {
            description = "${remcodex.meta.description} with whisper-ctranslate2 on PATH";
          };
        };
      in {
        packages = {
          default = remcodex-with-whisper;
          inherit remcodex remcodex-with-whisper whisperModelTiny;
        };

        apps = {
          default = {
            type = "app";
            program = "${remcodex-with-whisper}/bin/remcodex";
          };
          remcodex = {
            type = "app";
            program = "${remcodex}/bin/remcodex";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pkgs.pkg-config
            pkgs.python3
            pkgs.whisper-ctranslate2
            pkgs.ffmpeg
          ];

          shellHook = ''
            export REMCODEX_STT_BINARY=${pkgs.whisper-ctranslate2}/bin/whisper-ctranslate2
            export REMCODEX_STT_MODEL_PATH=${whisperModelTiny}
            echo "Node $(node --version) and whisper support are available."
          '';
        };
      });
}
