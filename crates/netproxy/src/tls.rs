//! TLS for HTTPS proxies and for the connectivity check: certificates are verified with the operating system's
//! trust store (the same verifier the runtime downloader uses). Tests may trust an extra root instead.

use rustls::ClientConfig;
use rustls::pki_types::{CertificateDer, ServerName};
use rustls_platform_verifier::BuilderVerifierExt;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::TlsConnector;

#[derive(Clone, Debug, Default)]
pub enum TlsTrust {
    /// The operating system's trust store (production).
    #[default]
    Platform,
    /// Only these roots (tests with their own certificate authority).
    Roots(Vec<CertificateDer<'static>>),
}

pub fn client_config(trust: &TlsTrust) -> Result<Arc<ClientConfig>, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder =
        ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions()?;
    let config = match trust {
        TlsTrust::Platform => builder.with_platform_verifier()?.with_no_client_auth(),
        TlsTrust::Roots(roots) => {
            let mut store = rustls::RootCertStore::empty();
            for r in roots {
                store.add(r.clone())?;
            }
            builder.with_root_certificates(store).with_no_client_auth()
        }
    };
    Ok(Arc::new(config))
}

pub(crate) async fn connect<S: AsyncRead + AsyncWrite + Unpin>(
    trust: &TlsTrust,
    host: &str,
    tcp: S,
) -> Result<tokio_rustls::client::TlsStream<S>, crate::ProxyError> {
    let config = client_config(trust).map_err(|_| crate::ProxyError::TlsFailed)?;
    let name = ServerName::try_from(host.to_owned()).map_err(|_| crate::ProxyError::TlsFailed)?;
    TlsConnector::from(config)
        .connect(name, tcp)
        .await
        .map_err(|_| crate::ProxyError::TlsFailed)
}
