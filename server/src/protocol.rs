//! v2 wire protocol — 32-byte big-endian header + AES-256-GCM envelope.
//!
//! See `docs/WIRE_SPEC.md` for the normative byte-for-byte specification.

use serde::{Deserialize, Serialize};

pub const HEADER_SIZE: usize = 32;
pub const EXPLICIT_IV_SIZE: usize = 8;
pub const SESSION_SALT_SIZE: usize = 4;
pub const AEAD_TAG_SIZE: usize = 16;
pub const AES256_KEY_SIZE: usize = 32;
pub const NONCE_SIZE: usize = SESSION_SALT_SIZE + EXPLICIT_IV_SIZE;
pub const MAX_UDP_PACKET: usize = 1500;
pub const PROTOCOL_VERSION: u8 = 0x02;
pub const CHANNEL_ID_MIX: u32 = 0xFFFF_FFFF;

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketType {
    Audio = 0, Keepalive = 1, Ping = 2, Pong = 3, Mixed = 4, Silence = 5,
}
impl PacketType {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v { 0=>Some(Self::Audio),1=>Some(Self::Keepalive),2=>Some(Self::Ping),
                   3=>Some(Self::Pong),4=>Some(Self::Mixed),5=>Some(Self::Silence),_=>None }
    }
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadType { Opus48kMono = 0, Opus48kStereo = 1, PcmS16 = 2 }
impl PayloadType {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v { 0=>Some(Self::Opus48kMono),1=>Some(Self::Opus48kStereo),2=>Some(Self::PcmS16),_=>None }
    }
}

pub mod flags {
    pub const FEC: u8 = 0b0000_0001;
    pub const DTX: u8 = 0b0000_0010;
    pub const MARKER: u8 = 0b0000_0100;
    pub const MIX_EGRESS: u8 = 0b0000_1000;
}

#[derive(Debug, Clone, Copy)]
pub struct Header {
    pub version: u8, pub packet_type: u8, pub payload_type: u8, pub flags: u8,
    pub sequence: u32, pub timestamp: u32, pub channel_id: u32, pub client_id: u64,
    pub server_id: u32, pub key_version: u16, pub payload_length: u16,
}

impl Header {
    #[inline]
    pub fn parse(buf: &[u8]) -> Option<Self> {
        if buf.len() < HEADER_SIZE { return None; }
        let version = buf[0];
        if version != PROTOCOL_VERSION { return None; }
        Some(Self {
            version, packet_type: buf[1], payload_type: buf[2], flags: buf[3],
            sequence: u32::from_be_bytes(buf[4..8].try_into().unwrap()),
            timestamp: u32::from_be_bytes(buf[8..12].try_into().unwrap()),
            channel_id: u32::from_be_bytes(buf[12..16].try_into().unwrap()),
            client_id: u64::from_be_bytes(buf[16..24].try_into().unwrap()),
            server_id: u32::from_be_bytes(buf[24..28].try_into().unwrap()),
            key_version: u16::from_be_bytes(buf[28..30].try_into().unwrap()),
            payload_length: u16::from_be_bytes(buf[30..32].try_into().unwrap()),
        })
    }
    #[inline]
    pub fn encode(&self, out: &mut [u8]) {
        assert!(out.len() >= HEADER_SIZE);
        out[0] = self.version; out[1] = self.packet_type;
        out[2] = self.payload_type; out[3] = self.flags;
        out[4..8].copy_from_slice(&self.sequence.to_be_bytes());
        out[8..12].copy_from_slice(&self.timestamp.to_be_bytes());
        out[12..16].copy_from_slice(&self.channel_id.to_be_bytes());
        out[16..24].copy_from_slice(&self.client_id.to_be_bytes());
        out[24..28].copy_from_slice(&self.server_id.to_be_bytes());
        out[28..30].copy_from_slice(&self.key_version.to_be_bytes());
        out[30..32].copy_from_slice(&self.payload_length.to_be_bytes());
    }
    pub fn is_audio(&self) -> bool {
        matches!(PacketType::from_u8(self.packet_type),
                 Some(PacketType::Audio) | Some(PacketType::Mixed))
    }
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ChannelId(pub u32);
impl std::fmt::Display for ChannelId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.0) }
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ClientId(pub u64);
impl std::fmt::Display for ClientId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{:016x}", self.0) }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode { Mix, Forward }
impl Default for SessionMode { fn default() -> Self { Self::Mix } }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PttMuteScope { All, Others, None }
impl Default for PttMuteScope { fn default() -> Self { Self::All } }

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority { Normal = 0, High = 1, Emergency = 2, ImminentPeril = 3 }
impl Default for Priority { fn default() -> Self { Self::Normal } }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelPriorityRole { Normal, Monitor, EmergencyOverride }
impl Default for ChannelPriorityRole { fn default() -> Self { Self::Normal } }
