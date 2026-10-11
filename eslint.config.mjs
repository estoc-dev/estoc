import tseslint from "typescript-eslint";

export default [
  {
    files: ["packages/agent-core/src/**/*.ts"],
    languageOptions: { parser: tseslint.parser, globals: { window: "readonly", self: "readonly", global: "readonly" } },
    rules: {
      "no-restricted-globals": [
        "error",
        {
          globals: [
            { name: "fetch", message: "A request goes through a Lifetime's fetch, so that none is made once the agent closed." },
            { name: "WebSocket", message: "A socket is opened through a Lifetime's sockets, so that none is opened once the agent closed." },
          ],
          checkGlobalObject: true,
          globalObjects: ["global"],
        },
      ],
    },
  },
];
