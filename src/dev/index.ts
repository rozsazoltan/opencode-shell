import { Plugin } from "@opencode/plugin"
import { augment } from "../index"

export default Plugin.define({
  id: "opencode-shell-dev",
  async setup(ctx) {
    await ctx.shell.hook("create.before", augment)
  },
})
