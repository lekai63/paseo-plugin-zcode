import type { PluginClientContext } from "@getpaseo/plugin/client";

import { contributeZcodeQuota } from "./client/quota";

export default function contribute(client: PluginClientContext) {
  return contributeZcodeQuota(client);
}
