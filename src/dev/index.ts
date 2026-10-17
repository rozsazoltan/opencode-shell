import { Plugin } from "@opencode/plugin"
import { setup } from "../index"

export default Plugin.define({
  id: "opencode-shell-dev",
  async setup(ctx) {
    await setup(ctx, "opencode-shell-dev")
  },
})
