export const SUPPORTED_OPENAI_MODELS = [
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-5.6-sol',
    'gpt-5.5',
    'gpt-5.5-mini',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.2',
    'gpt-5.2-chat-latest',
    'gpt-5.1',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4o',
    'gpt-4o-mini',
] as const

export type SupportedOpenAIModel = (typeof SUPPORTED_OPENAI_MODELS)[number]
export type LLMProviderId = 'openai' | 'vexke'

export const LLM_PROVIDERS: Array<{ id: LLMProviderId; label: string; requiresStream: boolean }> = [
    { id: 'openai', label: 'OpenAI', requiresStream: false },
    { id: 'vexke', label: 'Vexke', requiresStream: true },
]

export const DEFAULT_LLM_PROVIDER: LLMProviderId = 'openai'

const EXCLUDED_OPENAI_MODEL_ID_PARTS = [
    'audio',
    'codex',
    'computer',
    'dall-e',
    'embedding',
    'image',
    'moderation',
    'realtime',
    'search',
    'sora',
    'transcribe',
    'tts',
    'whisper',
]

export type OpenAIModelOption = {
    id: string
    ownedBy?: string
    provider: LLMProviderId
    source: LLMProviderId | 'fallback'
}

export type LLMModelOption = OpenAIModelOption

export function isLLMProviderId(value: string | null | undefined): value is LLMProviderId {
    return value === 'openai' || value === 'vexke'
}

export function getDefaultLLMProvider(): LLMProviderId {
    const configured = process.env.LLM_DEFAULT_PROVIDER?.trim().toLowerCase()
    return isLLMProviderId(configured) ? configured : DEFAULT_LLM_PROVIDER
}

export function isAllowedOpenAIChatModelId(model: string): boolean {
    const normalized = model.trim().toLowerCase()
    if (!normalized || normalized.length > 100) return false
    if (!/^[a-z0-9][a-z0-9._:-]*$/.test(normalized)) return false
    if (!normalized.startsWith('gpt-')) return false
    return !EXCLUDED_OPENAI_MODEL_ID_PARTS.some((part) => normalized.includes(part))
}

export function isSupportedOpenAIModel(model: string): boolean {
    return isAllowedOpenAIChatModelId(model)
}

export function getFallbackOpenAIModelOptions(): OpenAIModelOption[] {
    return SUPPORTED_OPENAI_MODELS.map((id) => ({ id, provider: 'openai', source: 'fallback' }))
}

export function normalizeOpenAIModelOptions(models: Array<{ id: string; owned_by?: string }>): OpenAIModelOption[] {
    const seen = new Set<string>()
    const options: OpenAIModelOption[] = []

    for (const model of models) {
        const id = model.id.trim()
        if (!isAllowedOpenAIChatModelId(id) || seen.has(id)) {
            continue
        }
        seen.add(id)
        options.push({ id, ownedBy: model.owned_by, provider: 'openai', source: 'openai' })
    }

    return options.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
}

export function getFallbackVexkeModelOptions(): LLMModelOption[] {
    const configured = (process.env.VEXKE_MODEL_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    const ids = [
        'gpt-5.6-luna',
        'gpt-5.6-terra',
        'gpt-5.6-sol',
        'gpt-5.4',
        'gpt-5.4-mini',
        ...configured,
    ]
    return Array.from(new Set(ids))
        .filter(isAllowedOpenAIChatModelId)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((id) => ({ id, provider: 'vexke', source: 'fallback' }))
}

export function getFallbackLLMModelOptions(): LLMModelOption[] {
    return [...getFallbackOpenAIModelOptions(), ...getFallbackVexkeModelOptions()]
}

export function isAllowedChatModelId(provider: LLMProviderId, model: string): boolean {
    switch (provider) {
        case 'openai':
        case 'vexke':
            return isAllowedOpenAIChatModelId(model)
        default:
            return false
    }
}

export type ChatCompletionsTokenParamName = 'max_tokens' | 'max_completion_tokens'

export function getChatCompletionsTokenParamName(model: string): ChatCompletionsTokenParamName {
    const normalized = model.trim().toLowerCase()
    if (normalized.startsWith('gpt-5')) return 'max_completion_tokens'
    return 'max_tokens'
}

export function buildChatCompletionsTokenParam(model: string, maxTokens: number): Record<ChatCompletionsTokenParamName, number> {
    const key = getChatCompletionsTokenParamName(model)
    return { [key]: maxTokens } as Record<ChatCompletionsTokenParamName, number>
}

export type ChatCompletionsTokenBudget = {
    tokenParam: ChatCompletionsTokenParamName
    requestedMaxTokens: number
    effectiveMaxTokens: number
    clamped: boolean
    param: Record<ChatCompletionsTokenParamName, number>
}

// GPT-5 family can spend completion tokens on reasoning with zero output tokens if the budget is too low.
// Clamp to a safer minimum so the model can emit actual user-visible text.
export const GPT5_MIN_MAX_COMPLETION_TOKENS = 1024

export function getChatCompletionsTokenBudget(model: string, requestedMaxTokens: number): ChatCompletionsTokenBudget {
    const tokenParam = getChatCompletionsTokenParamName(model)

    if (tokenParam === 'max_completion_tokens') {
        const effectiveMaxTokens = Math.max(GPT5_MIN_MAX_COMPLETION_TOKENS, requestedMaxTokens)
        return {
            tokenParam,
            requestedMaxTokens,
            effectiveMaxTokens,
            clamped: effectiveMaxTokens !== requestedMaxTokens,
            param: buildChatCompletionsTokenParam(model, effectiveMaxTokens),
        }
    }

    return {
        tokenParam,
        requestedMaxTokens,
        effectiveMaxTokens: requestedMaxTokens,
        clamped: false,
        param: buildChatCompletionsTokenParam(model, requestedMaxTokens),
    }
}

export type ExtractedChatCompletionText =
    | { text: string; source: 'message.content' | 'message.content.parts' | 'message.refusal' | 'message.tool_calls.arguments' }
    | { text: null; source: 'missing' }

function readObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function extractChatCompletionsText(data: unknown): ExtractedChatCompletionText {
    const root = readObject(data)
    const choices = Array.isArray(root?.choices) ? root.choices : []
    const choice = readObject(choices[0])
    const message = readObject(choice?.message)

    const refusal = message?.refusal
    if (typeof refusal === 'string' && refusal.trim().length > 0) {
        return { text: refusal.trim(), source: 'message.refusal' }
    }

    const content = message?.content
    if (typeof content === 'string') {
        const trimmed = content.trim()
        if (trimmed.length > 0) return { text: trimmed, source: 'message.content' }
        // empty string => treat as missing (try other fallbacks)
    } else if (Array.isArray(content)) {
        const parts = content
            .map((p: unknown) => {
                if (typeof p === 'string') return p
                const part = readObject(p)
                if (typeof part?.text === 'string') return part.text
                if (typeof part?.content === 'string') return part.content
                return ''
            })
            .join('')
            .trim()
        if (parts.length > 0) {
            return { text: parts, source: 'message.content.parts' }
        }
    }

    const toolCalls = message?.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const toolCall = readObject(toolCalls[0])
        const fn = readObject(toolCall?.function)
        const args = fn?.arguments
        if (typeof args === 'string' && args.trim().length > 0) {
            return { text: args.trim(), source: 'message.tool_calls.arguments' }
        }
    }

    return { text: null, source: 'missing' }
}

export type ChatModelPricing = {
    inputPer1M: number
    cachedInputPer1M: number
    outputPer1M: number
}

export type ChatUsageForCost = {
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
}

const DEFAULT_CHAT_PRICING: Record<string, ChatModelPricing> = {
    // Keep only broadly stable defaults; override with CSE_OPENAI_CHAT_PRICING_JSON when needed.
    'gpt-4o': { inputPer1M: 2.5, cachedInputPer1M: 1.25, outputPer1M: 10 },
    'gpt-4o-mini': { inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.6 },
}

let cachedParsedPricingEnvRaw: string | null = null
let cachedParsedPricingEnvValue: Record<string, ChatModelPricing> | null = null

function parsePricingEnv(): Record<string, ChatModelPricing> {
    const raw = (process.env.CSE_OPENAI_CHAT_PRICING_JSON || '').trim()
    if (!raw) return {}
    if (cachedParsedPricingEnvRaw === raw && cachedParsedPricingEnvValue) {
        return cachedParsedPricingEnvValue
    }

    try {
        const parsed = JSON.parse(raw)
        const normalized: Record<string, ChatModelPricing> = {}
        if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                const pricing = readObject(v)
                const inputPer1M = Number(pricing?.inputPer1M)
                const cachedInputPer1M = Number(pricing?.cachedInputPer1M)
                const outputPer1M = Number(pricing?.outputPer1M)
                if (
                    Number.isFinite(inputPer1M) &&
                    Number.isFinite(cachedInputPer1M) &&
                    Number.isFinite(outputPer1M) &&
                    inputPer1M >= 0 &&
                    cachedInputPer1M >= 0 &&
                    outputPer1M >= 0
                ) {
                    normalized[k.toLowerCase()] = { inputPer1M, cachedInputPer1M, outputPer1M }
                }
            }
        }
        cachedParsedPricingEnvRaw = raw
        cachedParsedPricingEnvValue = normalized
        return normalized
    } catch {
        return {}
    }
}

export function resolveChatModelPricing(model: string): ChatModelPricing | null {
    const normalizedModel = model.trim().toLowerCase()
    const envPricing = parsePricingEnv()
    const pricingTable = { ...DEFAULT_CHAT_PRICING, ...envPricing }

    if (pricingTable[normalizedModel]) return pricingTable[normalizedModel]

    // Match versioned model names (e.g. gpt-5.2-2025-12-11).
    let bestMatch: string | null = null
    for (const key of Object.keys(pricingTable)) {
        if (normalizedModel === key || normalizedModel.startsWith(`${key}-`)) {
            if (!bestMatch || key.length > bestMatch.length) bestMatch = key
        }
    }
    return bestMatch ? pricingTable[bestMatch] : null
}

export function estimateChatCompletionsCostUsd(
    model: string,
    usage: ChatUsageForCost
): {
    estimatedCostUsd: number | null
    pricingApplied: ChatModelPricing | null
    uncachedPromptTokens: number
    cachedPromptTokens: number
} {
    const promptTokens = Number.isFinite(usage.promptTokens) ? Math.max(0, Number(usage.promptTokens)) : 0
    const completionTokens = Number.isFinite(usage.completionTokens) ? Math.max(0, Number(usage.completionTokens)) : 0
    const cachedPromptTokens = Number.isFinite(usage.cachedTokens)
        ? Math.min(promptTokens, Math.max(0, Number(usage.cachedTokens)))
        : 0
    const uncachedPromptTokens = Math.max(0, promptTokens - cachedPromptTokens)

    const pricing = resolveChatModelPricing(model)
    if (!pricing) {
        return {
            estimatedCostUsd: null,
            pricingApplied: null,
            uncachedPromptTokens,
            cachedPromptTokens,
        }
    }

    const inputCost = (uncachedPromptTokens / 1_000_000) * pricing.inputPer1M
    const cachedInputCost = (cachedPromptTokens / 1_000_000) * pricing.cachedInputPer1M
    const outputCost = (completionTokens / 1_000_000) * pricing.outputPer1M

    return {
        estimatedCostUsd: inputCost + cachedInputCost + outputCost,
        pricingApplied: pricing,
        uncachedPromptTokens,
        cachedPromptTokens,
    }
}
