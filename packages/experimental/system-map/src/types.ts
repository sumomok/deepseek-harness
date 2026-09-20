/**
 * The values the three reads answer with, and the ceilings they are built
 * under.
 *
 * Types only: every function that builds one of these lives in
 * [`reduce.ts`](./reduce.ts), and every sentence a model reads about one lives
 * in [`text.ts`](./text.ts).
 * @module @deepseek-ai/dsh-experimental-system-map/types
 */

/**
 * The ceilings one deployment reads under, already validated.
 *
 * Every one of them bounds what a single call emits, because that is the value
 * a model pays for: a deployment with ten times the models of another pays ten
 * times for the same question unless the listing stops somewhere.
 */
export interface MapBounds {
  /** Most characters one listing may render, counted over the whole answer including its heading. */
  readonly listingChars: number
  /** Most fixed values one attribute may contribute before the rest are counted instead. */
  readonly valuesPerAttribute: number
  /** Most characters one recorded note may contribute. */
  readonly noteChars: number
}

/** One subject area of the deployment, with how much of its business is filed under it. */
export interface DomainEntry {
  /** The code this deployment files models under. */
  readonly domain: string
  /** The name this deployment shows for that code. */
  readonly name: string
  /** How many data models it holds. */
  readonly models: number
}

/** What a subject-area listing answers with. */
export interface DomainsValue {
  /** The subject areas, in code order. */
  readonly domains: DomainEntry[]
  /** How many entries of the whole listing come before this answer's first. */
  readonly from: number
  /** How many this answer carries. */
  readonly shown: number
  /** How many the deployment has in full. */
  readonly total: number
  /** Whether the listing stops short of all of them. */
  readonly truncated: boolean
  /** The code to pass back to continue; present only on a listing cut short. */
  readonly cursor?: string
}

/** One data model as a subject-area listing names it. */
export interface ModelEntry {
  /** The name this deployment keys the model by. */
  readonly model: string
  /** The name this deployment shows a person. */
  readonly name?: string
  /** Where the model's rows are stored. */
  readonly table?: string
  /** The operations the signed-in person may perform, by this deployment's own operation names. */
  readonly may?: string[]
  /** What this deployment records about the model, cut to the deployment's note ceiling. */
  readonly note?: string
}

/** What a model listing answers with. */
export interface DomainModelsValue {
  /** The subject area listed, by its code. */
  readonly domain: string
  /** The name this deployment shows for that code. */
  readonly name: string
  /** The models, in English-name order. */
  readonly models: ModelEntry[]
  /** How many models of the subject area come before this answer's first. */
  readonly from: number
  /** How many this answer carries. */
  readonly shown: number
  /** How many the subject area holds in full. */
  readonly total: number
  /** Whether the listing stops short of all of them. */
  readonly truncated: boolean
  /** The model name to pass back to continue; present only on a listing cut short. */
  readonly cursor?: string
}

/** One fixed value an attribute offers. */
export interface AttributeValue {
  /** The value as a row stores it. */
  readonly stored: string
  /** The text the deployment shows for it. */
  readonly shown: string
}

/** One attribute of a model, with everything this deployment states about it. */
export interface AttributeEntry {
  /** The name rows are keyed by. */
  readonly attribute: string
  /** The name this deployment shows a person. */
  readonly name?: string
  /** The stored type, in this deployment's own type vocabulary. */
  readonly type?: string
  /** Longest stored value the model accepts. */
  readonly length?: number
  /** Whether the attribute is part of what identifies a row. */
  readonly key?: boolean
  /** Whether a row may leave the attribute empty. */
  readonly nullable?: boolean
  /** The value stored when a person enters none. */
  readonly default?: string
  /** The group this deployment's own forms file the attribute under. */
  readonly group?: string
  /** Whether a form refuses to save without a value. */
  readonly required?: boolean
  /** Whether the forms let this person change the value. */
  readonly editable?: boolean
  /** Which of this deployment's own forms draw the attribute. */
  readonly forms?: string[]
  /** The model the attribute takes a row of, by its English name. */
  readonly picks?: string
  /** The fixed values it offers, cut to the deployment's value ceiling. */
  readonly values?: AttributeValue[]
  /** How many further fixed values the ceiling left out. */
  readonly moreValues?: number
}

/** What one model read answers with. */
export interface ModelValue {
  /** The name this deployment keys the model by. */
  readonly model: string
  /** The name this deployment shows a person. */
  readonly name?: string
  /** The subject area it is filed under, by its code. */
  readonly domain: string
  /** The name this deployment shows for that code. */
  readonly domainName: string
  /** Where the model's rows are stored. */
  readonly table?: string
  /** The model this one extends, by its English name. */
  readonly parent?: string
  /** What this deployment records about the model, cut to the deployment's note ceiling. */
  readonly note?: string
  /** The attributes, in English-name order. */
  readonly attributes: AttributeEntry[]
  /** The operations the signed-in person may perform, by this deployment's own operation names. */
  readonly may: string[]
  /** The attributes editing is narrowed to, where the rights table narrows it. */
  readonly editableColumns?: string[]
  /** How many attributes of the model come before this answer's first. */
  readonly from: number
  /** How many attributes this answer carries. */
  readonly shown: number
  /** How many the model has in full. */
  readonly total: number
  /** Whether the listing stops short of all of them. */
  readonly truncated: boolean
  /** The attribute name to pass back to continue; present only on a listing cut short. */
  readonly cursor?: string
}
