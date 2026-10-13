//! Routing adapter against in-process HTTP, HTTPS and SOCKS5 proxies (feature `testing`).
//!
//! A raw TCP client plays the browser: it talks to the gateway exactly as Chromium does with
//! `--proxy-server=http://127.0.0.1:<port>` (`CONNECT` for tunnels, absolute-form `GET` for plain http).
#![cfg(feature = "testing")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use pb_netproxy::check::{self, CheckTarget};
use pb_netproxy::gateway::{Fallback, Gateway};
use pb_netproxy::testing::{ProxyOptions, TestCa, TestCheckService, TestOrigin, TestProxy};
use pb_netproxy::tls::TlsTrust;
use pb_netproxy::upstream::connect_via;
use pb_netproxy::{
    AddressPolicy, Credentials, NetRuntime, ProxyError, ProxyKind, Target, Upstream,
};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

fn creds(u: &str, p: &str) -> Credentials {
    Credentials {
        username: u.into(),
        password: p.into(),
    }
}

fn hosts(pairs: &[(&str, std::net::SocketAddr)]) -> HashMap<String, std::net::SocketAddr> {
    pairs.iter().map(|(n, a)| ((*n).to_owned(), *a)).collect()
}

/// Sends `request` to the gateway as the browser would and returns everything it answered.
fn browser_request(port: u16, request: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    s.write_all(request.as_bytes()).unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out);
    String::from_utf8_lossy(&out).into_owned()
}

/// `CONNECT` through the gateway, then an HTTP request inside the tunnel.
fn browser_tunnel(port: u16, authority: &str, path: &str) -> (String, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    s.write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes())
        .unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if s.read(&mut byte).unwrap_or(0) == 0 {
            break;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    if !head.starts_with("HTTP/1.1 200") {
        let mut rest = Vec::new();
        let _ = s.read_to_end(&mut rest);
        return (head + &String::from_utf8_lossy(&rest), String::new());
    }
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes())
        .unwrap();
    let mut body = Vec::new();
    let _ = s.read_to_end(&mut body);
    (head, String::from_utf8_lossy(&body).into_owned())
}

fn net() -> Arc<NetRuntime> {
    NetRuntime::new().unwrap()
}

#[test]
fn http_proxy_with_basic_login_carries_tunnels_and_plain_http() {
    let origin = TestOrigin::start();
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("alice".into(), "s3cret".into())),
        hosts: hosts(&[("origin.pb.test", origin.addr())]),
        ..Default::default()
    });
    let net = net();
    let gw = Gateway::start(
        &net,
        0,
        proxy.upstream(Some(creds("alice", "s3cret"))),
        TlsTrust::Platform,
    )
    .unwrap();

    let plain = browser_request(
        gw.port(),
        "GET http://origin.pb.test/page?x=1 HTTP/1.1\r\nHost: origin.pb.test\r\nAccept: */*\r\n\r\n",
    );
    assert!(plain.contains("origin /page?x=1"), "{plain}");
    let (head, body) = browser_tunnel(gw.port(), "origin.pb.test:80", "/tunnel");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(body.contains("origin /tunnel"), "{body}");

    let log = proxy.log();
    assert_eq!(log.len(), 2, "{log:?}");
    assert!(
        log.iter()
            .all(|e| e.accepted && e.login.as_deref() == Some("Basic YWxpY2U6czNjcmV0"))
    );
    assert!(log.iter().any(|e| e.request == "CONNECT origin.pb.test:80"));
    assert!(
        log.iter()
            .any(|e| e.request == "GET http://origin.pb.test/page?x=1")
    );
    // The login goes only to the proxy, never to the website.
    for r in origin.seen() {
        assert!(r.header("proxy-authorization").is_none(), "{r:?}");
    }
    let st = gw.status();
    assert_eq!((st.failures, st.consecutive_failures), (0, 0));
    assert!(st.last_success_at.is_some());
}

#[test]
fn a_wrong_or_missing_login_fails_visibly_and_never_prompts_the_browser() {
    let origin = TestOrigin::start();
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("alice".into(), "s3cret".into())),
        hosts: hosts(&[("origin.pb.test", origin.addr())]),
        ..Default::default()
    });
    let net = net();
    for (login, code) in [
        (Some(creds("alice", "wrong")), "PROXY_AUTH_FAILED"),
        (None, "PROXY_AUTH_REQUIRED"),
    ] {
        let gw = Gateway::start(&net, 0, proxy.upstream(login), TlsTrust::Platform).unwrap();
        let (head, _) = browser_tunnel(gw.port(), "origin.pb.test:80", "/");
        assert!(head.starts_with("HTTP/1.1 502"), "{head}");
        assert!(head.contains(&format!("X-Pb-Error: {code}")), "{head}");
        let plain = browser_request(
            gw.port(),
            "GET http://origin.pb.test/ HTTP/1.1\r\nHost: origin.pb.test\r\n\r\n",
        );
        assert!(
            plain.starts_with("HTTP/1.1 502"),
            "a 407 never reaches the browser: {plain}"
        );
        assert!(!plain.contains("Proxy-Authenticate"), "{plain}");
        assert_eq!(gw.status().last_error, Some(code));
    }
    assert!(origin.seen().is_empty(), "nothing reached the site");
}

#[test]
fn unsupported_login_methods_are_named() {
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("alice".into(), "s3cret".into())),
        digest_only: true,
        ..Default::default()
    });
    let net = net();
    let err = net
        .block_on(connect_via(
            &proxy.upstream(Some(creds("alice", "s3cret"))),
            &TlsTrust::Platform,
            &Target {
                host: "origin.pb.test".into(),
                port: 443,
            },
        ))
        .err();
    assert_eq!(err, Some(ProxyError::AuthUnsupported("digest".into())));
    assert_eq!(err.map(|e| e.code()), Some("PROXY_AUTH_UNSUPPORTED"));
}

#[test]
fn socks5_with_login_lets_the_proxy_resolve_names() {
    let origin = TestOrigin::start();
    let proxy = TestProxy::socks5(ProxyOptions {
        login: Some(("bob".into(), "p:a:ss".into())),
        hosts: hosts(&[("origin.pb.test", origin.addr())]),
        ..Default::default()
    });
    let net = net();
    let gw = Gateway::start(
        &net,
        0,
        proxy.upstream(Some(creds("bob", "p:a:ss"))),
        TlsTrust::Platform,
    )
    .unwrap();
    let (head, body) = browser_tunnel(gw.port(), "origin.pb.test:443", "/s");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(body.contains("origin /s"), "{body}");
    let plain = browser_request(
        gw.port(),
        "GET http://origin.pb.test/p HTTP/1.1\r\nHost: origin.pb.test\r\n\r\n",
    );
    assert!(plain.contains("origin /p"), "{plain}");
    let log = proxy.log();
    assert!(
        log.iter()
            .all(|e| e.request.starts_with("SOCKS5 domain origin.pb.test:")
                && e.login.as_deref() == Some("bob:p:a:ss")),
        "names are sent to the proxy, not resolved here: {log:?}"
    );
    // Wrong password.
    let bad = Gateway::start(
        &net,
        0,
        proxy.upstream(Some(creds("bob", "nope"))),
        TlsTrust::Platform,
    )
    .unwrap();
    let (head, _) = browser_tunnel(bad.port(), "origin.pb.test:443", "/");
    assert!(head.contains("X-Pb-Error: PROXY_AUTH_FAILED"), "{head}");
    // No login saved for a proxy that needs one.
    let none = Gateway::start(&net, 0, proxy.upstream(None), TlsTrust::Platform).unwrap();
    let (head, _) = browser_tunnel(none.port(), "origin.pb.test:443", "/");
    assert!(head.contains("X-Pb-Error: PROXY_AUTH_REQUIRED"), "{head}");
}

#[test]
fn https_proxies_have_their_certificate_verified() {
    let origin = TestOrigin::start();
    let ca = TestCa::new(&["proxy.pb.test"]);
    let proxy = TestProxy::https(ProxyOptions {
        login: Some(("carol".into(), "pw".into())),
        hosts: hosts(&[("origin.pb.test", origin.addr())]),
        tls: Some(ca.clone()),
        ..Default::default()
    });
    let net = net();
    let gw = Gateway::start(
        &net,
        0,
        proxy.upstream(Some(creds("carol", "pw"))),
        ca.trust(),
    )
    .unwrap();
    let (head, body) = browser_tunnel(gw.port(), "origin.pb.test:80", "/tls");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(body.contains("origin /tls"));
    let plain = browser_request(
        gw.port(),
        "GET http://origin.pb.test/plain HTTP/1.1\r\nHost: origin.pb.test\r\n\r\n",
    );
    assert!(plain.contains("origin /plain"), "{plain}");
    // An untrusted certificate (here: not in the system store) is refused.
    let untrusted = Gateway::start(
        &net,
        0,
        proxy.upstream(Some(creds("carol", "pw"))),
        TlsTrust::Platform,
    )
    .unwrap();
    let (head, _) = browser_tunnel(untrusted.port(), "origin.pb.test:80", "/");
    assert!(head.contains("X-Pb-Error: PROXY_TLS_FAILED"), "{head}");
}

#[test]
fn an_outage_blocks_traffic_and_recovers_when_the_proxy_returns() {
    let origin = TestOrigin::start();
    let proxy = TestProxy::http(ProxyOptions {
        hosts: hosts(&[("origin.pb.test", origin.addr())]),
        ..Default::default()
    });
    let net = net();
    let gw = Gateway::start(&net, 0, proxy.upstream(None), TlsTrust::Platform).unwrap();
    assert!(
        browser_tunnel(gw.port(), "origin.pb.test:80", "/before")
            .1
            .contains("origin /before")
    );
    let seen_before = origin.seen().len();

    proxy.stop();
    let (head, _) = browser_tunnel(gw.port(), "origin.pb.test:80", "/during");
    assert!(head.contains("X-Pb-Error: PROXY_UNREACHABLE"), "{head}");
    let plain = browser_request(
        gw.port(),
        "GET http://origin.pb.test/during HTTP/1.1\r\nHost: origin.pb.test\r\n\r\n",
    );
    assert!(
        plain.contains("Nothing was sent without the proxy"),
        "{plain}"
    );
    assert_eq!(
        origin.seen().len(),
        seen_before,
        "no request reached the site while the proxy was down"
    );
    let st = gw.status();
    assert_eq!(
        (st.consecutive_failures, st.last_error),
        (2, Some("PROXY_UNREACHABLE"))
    );

    proxy.restart();
    assert!(
        browser_tunnel(gw.port(), "origin.pb.test:80", "/after")
            .1
            .contains("origin /after")
    );
    assert_eq!(gw.status().consecutive_failures, 0, "recovered");
}

#[test]
fn fail_open_goes_direct_only_when_the_proxy_cannot_be_reached_and_counts_it() {
    let origin = TestOrigin::start();
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("alice".into(), "right".into())),
        ..Default::default()
    });
    let net = net();
    let authority = origin.addr().to_string();
    let gw = Gateway::start_with(
        &net,
        0,
        proxy.upstream(Some(creds("alice", "wrong"))),
        TlsTrust::Platform,
        Fallback::Direct,
    )
    .unwrap();
    // A rejected login is a configuration problem, never a reason to go direct.
    let (head, _) = browser_tunnel(gw.port(), &authority, "/login");
    assert!(head.contains("X-Pb-Error: PROXY_AUTH_FAILED"), "{head}");
    assert!(origin.seen().is_empty());
    assert_eq!(gw.status().direct_connections, 0);

    // An unreachable proxy falls back, and every direct connection is counted.
    proxy.stop();
    let (head, body) = browser_tunnel(gw.port(), &authority, "/tunnel");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(body.contains("origin /tunnel"), "{body}");
    let plain = browser_request(
        gw.port(),
        &format!("GET http://{authority}/plain HTTP/1.1\r\nHost: {authority}\r\n\r\n"),
    );
    assert!(plain.contains("origin /plain"), "{plain}");
    let st = gw.status();
    assert_eq!(st.direct_connections, 2);
    assert!(st.last_direct_at.is_some());
    assert_eq!(st.last_error, Some("PROXY_UNREACHABLE"));
}

#[test]
fn proxies_on_this_computer_need_the_local_policy() {
    let proxy = TestProxy::http(ProxyOptions::default());
    let net = net();
    let target = Target {
        host: "origin.pb.test".into(),
        port: 80,
    };
    for host in ["127.0.0.1", "localhost"] {
        let up = Upstream {
            kind: ProxyKind::Http,
            host: host.into(),
            port: proxy.port(),
            credentials: None,
            policy: AddressPolicy::default(),
        };
        let err = net
            .block_on(connect_via(&up, &TlsTrust::Platform, &target))
            .err();
        assert_eq!(err, Some(ProxyError::PrivateAddress), "{host}");
    }
    // Metadata-service addresses are never used, even with the local policy.
    let up = Upstream {
        kind: ProxyKind::Http,
        host: "169.254.169.254".into(),
        port: 80,
        credentials: None,
        policy: AddressPolicy {
            allow_private: true,
        },
    };
    assert_eq!(
        net.block_on(connect_via(&up, &TlsTrust::Platform, &target))
            .err(),
        Some(ProxyError::ForbiddenAddress)
    );
}

#[test]
fn ipv6_proxies_and_destinations() {
    let v6: IpAddr = "::1".parse().unwrap();
    let Some(origin) = TestOrigin::start_on(v6) else {
        eprintln!("skipped: no IPv6 loopback on this machine");
        return;
    };
    let proxy = TestProxy::socks5(ProxyOptions {
        bind: Some(v6),
        ..Default::default()
    });
    let net = net();
    let gw = Gateway::start(&net, 0, proxy.upstream(None), TlsTrust::Platform).unwrap();
    let (head, body) = browser_tunnel(gw.port(), &format!("[::1]:{}", origin.port), "/v6");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(body.contains("origin /v6"), "{body}");
    assert!(
        proxy
            .log()
            .iter()
            .any(|e| e.request == format!("SOCKS5 ip ::1:{}", origin.port))
    );
}

#[test]
fn connectivity_check_reports_latency_and_the_address_the_service_saw() {
    let service = TestCheckService::start("check.pb.test", "198.51.100.23");
    let proxy = TestProxy::http(ProxyOptions {
        login: Some(("alice".into(), "s3cret".into())),
        hosts: hosts(&[("check.pb.test", service.addr())]),
        ..Default::default()
    });
    let net = net();
    let target = CheckTarget {
        host: "check.pb.test".into(),
        port: 443,
        path: "/cdn-cgi/trace".into(),
    };
    let up = proxy.upstream(Some(creds("alice", "s3cret")));
    let out = net
        .block_on(check::run(&up, &service.ca.trust(), &target))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(out.egress_ip, "198.51.100.23".parse().ok());
    assert!(out.latency_ms < 10_000);
    assert_eq!(service.requests(), 1);
    // The service's certificate is verified too.
    assert_eq!(
        net.block_on(check::run(&up, &TlsTrust::Platform, &target))
            .err(),
        Some(ProxyError::TlsFailed)
    );
    // A dead proxy is reported as such.
    proxy.stop();
    assert_eq!(
        net.block_on(check::run(&up, &service.ca.trust(), &target))
            .err(),
        Some(ProxyError::Unreachable)
    );
}

#[test]
fn the_gateway_only_speaks_proxy_requests() {
    let proxy = TestProxy::http(ProxyOptions::default());
    let net = net();
    let gw = Gateway::start(&net, 0, proxy.upstream(None), TlsTrust::Platform).unwrap();
    for junk in [
        "GET / HTTP/1.1\r\nHost: x\r\n\r\n",
        "GET https://example.test/ HTTP/1.1\r\n\r\n",
        "GET http://user:pw@example.test/ HTTP/1.1\r\n\r\n",
        "CONNECT nonsense HTTP/1.1\r\n\r\n",
        "\u{16}\u{3}\u{1}garbage\r\n\r\n",
    ] {
        let out = browser_request(gw.port(), junk);
        assert!(out.starts_with("HTTP/1.1 400"), "{junk:?} -> {out}");
    }
    assert!(proxy.log().is_empty(), "nothing was forwarded");
    gw.stop();
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        TcpStream::connect(("127.0.0.1", gw.port())).is_err()
            || browser_request(gw.port(), "GET http://a/ HTTP/1.1\r\n\r\n").is_empty(),
        "a stopped gateway accepts nothing"
    );
}
