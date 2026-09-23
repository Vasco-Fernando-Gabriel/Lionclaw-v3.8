import { describe, it, expect } from 'vitest';
import { parsePrefixedMcpName } from '../prompt';

describe('parsePrefixedMcpName', () => {
  it('parses mcp__google-gmail__send_message', () => {
    expect(parsePrefixedMcpName('mcp__google-gmail__send_message')).toEqual({
      serverId: 'google-gmail',
      toolName: 'send_message',
    });
  });

  it('parses mcp__lionclaw-agents__call_agent', () => {
    expect(parsePrefixedMcpName('mcp__lionclaw-agents__call_agent')).toEqual({
      serverId: 'lionclaw-agents',
      toolName: 'call_agent',
    });
  });

  it('parses mcp__knowledge-base__search', () => {
    expect(parsePrefixedMcpName('mcp__knowledge-base__search')).toEqual({
      serverId: 'knowledge-base',
      toolName: 'search',
    });
  });

  it('parses mcp__knowledge_base__ingest_document (underscores in serverId)', () => {
    expect(parsePrefixedMcpName('mcp__knowledge_base__ingest_document')).toEqual({
      serverId: 'knowledge_base',
      toolName: 'ingest_document',
    });
  });

  it('greedy split: mcp__a_b__c__d -> { serverId: "a_b", toolName: "c__d" }', () => {
    expect(parsePrefixedMcpName('mcp__a_b__c__d')).toEqual({
      serverId: 'a_b',
      toolName: 'c__d',
    });
  });

  it('returns null for string without mcp__ prefix', () => {
    expect(parsePrefixedMcpName('send_message')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePrefixedMcpName('')).toBeNull();
  });

  it('returns null for mcp__ prefix with no serverId or toolName', () => {
    expect(parsePrefixedMcpName('mcp____')).toBeNull();
  });

  it('returns null for partial prefix mcp__serverId (no double underscore toolName sep)', () => {
    expect(parsePrefixedMcpName('mcp__google-gmail')).toBeNull();
  });

  it('parses tool names with hyphens', () => {
    expect(parsePrefixedMcpName('mcp__my-server__my-tool-name')).toEqual({
      serverId: 'my-server',
      toolName: 'my-tool-name',
    });
  });
});
