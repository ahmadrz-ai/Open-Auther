import { VIRTUAL_DESCRIPTIONS, VIRTUAL_MODELS } from "../core/virtual.js";

export interface ChatVirtualModel {
  id: string;
  providers: string[];
  available: boolean;
  description: string;
}

/** Build the virtual policies exposed by the built-in Chat model picker. */
export function virtualChatModels(
  providerIds: string[],
  hasRealModels: boolean,
  available = hasRealModels,
): ChatVirtualModel[] {
  if (!hasRealModels) return [];
  const providers = [...new Set(providerIds)].sort();
  return VIRTUAL_MODELS.map((id) => ({
    id,
    providers,
    available,
    description: VIRTUAL_DESCRIPTIONS[id],
  }));
}
