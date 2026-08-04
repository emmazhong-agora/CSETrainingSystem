import { NextResponse } from 'next/server'
import { withAdminAuth } from '@/lib/auth-middleware'
import {
    getFallbackOpenAIModelOptions,
    getFallbackVexkeModelOptions,
    normalizeOpenAIModelOptions,
    type LLMModelOption,
    type OpenAIModelOption,
} from '@/lib/services/openai-models'

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000

let cachedModels: {
    expiresAt: number
    data: LLMModelOption[]
    source: 'openai' | 'fallback' | 'mixed'
} | null = null

type OpenAIModelsResponse = {
    data?: Array<{
        id?: unknown
        owned_by?: unknown
    }>
}

async function fetchOpenAIModels(): Promise<OpenAIModelOption[]> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
        return []
    }

    const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
        next: { revalidate: 3600 },
    })

    if (!response.ok) {
        throw new Error(`OPENAI_MODELS_FETCH_FAILED:${response.status}`)
    }

    const payload = (await response.json()) as OpenAIModelsResponse
    const models = (payload.data ?? [])
        .map((model) => ({
            id: typeof model.id === 'string' ? model.id : '',
            owned_by: typeof model.owned_by === 'string' ? model.owned_by : undefined,
        }))
        .filter((model) => model.id)

    return normalizeOpenAIModelOptions(models)
}

export const GET = withAdminAuth(async () => {
    try {
        const now = Date.now()
        if (cachedModels && cachedModels.expiresAt > now) {
            return NextResponse.json({
                success: true,
                data: cachedModels.data,
                meta: { source: cachedModels.source, cached: true },
            })
        }

        const openAIModels = await fetchOpenAIModels()
        // Keep configured fallbacks selectable even when the provider catalog is incomplete.
        const openAIData = Array.from(
            new Map([...getFallbackOpenAIModelOptions(), ...openAIModels].map((model) => [model.id, model])).values(),
        ).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
        const vexkeData = getFallbackVexkeModelOptions()
        const data = [...openAIData, ...vexkeData]
        const source = openAIModels.length > 0 ? 'mixed' : 'fallback'

        cachedModels = {
            expiresAt: now + MODEL_CACHE_TTL_MS,
            data,
            source,
        }

        return NextResponse.json({
            success: true,
            data,
            meta: { source, cached: false },
        })
    } catch (error) {
        console.error('List LLM models error:', error)
        const data = [...getFallbackOpenAIModelOptions(), ...getFallbackVexkeModelOptions()]
        cachedModels = {
            expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
            data,
            source: 'fallback',
        }

        return NextResponse.json({
            success: true,
            data,
            meta: { source: 'fallback', cached: false },
        })
    }
})
