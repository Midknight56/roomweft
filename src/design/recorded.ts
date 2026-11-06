import warm from './recorded/warm-reading.json';
import calm from './recorded/calm-studio.json';
import night from './recorded/night-desk.json';
import saved from './recorded/saved-picks.json';
import type { Candidate } from '../shared/api-types';
import type { SlotId, Style } from '../shared/room';
export interface RecordedSlot { query: string; maxPrice: number; resultIds: string[]; retrievedAt: number; candidates: Candidate[] }
export interface RecordedRun { style: string; capturedAt: string; slots: Record<SlotId,RecordedSlot> }
export const recordedRuns = { 'warm-reading': warm, 'calm-studio': calm, 'night-desk': night } as Record<Style['id'],RecordedRun>;
export const recordedPicks = saved as Partial<Record<Style['id'],{picks:unknown;neurons:number;at:string}>>;
