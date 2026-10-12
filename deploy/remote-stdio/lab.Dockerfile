# Disposable qualification fixture, not a production container deployment.
FROM node:26.5.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --home-dir /srv/foundry-mcp --shell /bin/sh --password '*' foundry-mcp \
    && chmod 700 /srv/foundry-mcp \
    && useradd --create-home --shell /bin/sh unrelated \
    && chmod 700 /home/unrelated \
    && install -d -m 700 /opt/unrelated-app \
    && touch /home/unrelated/private /opt/unrelated-app/private \
    && chown unrelated:unrelated /home/unrelated/private \
    && install -d /run/sshd /usr/local/libexec \
    && ln -s /usr/local/bin/node /usr/local/libexec/foundry-mcp-node \
    && ln -s /usr/local/bin/npm /usr/local/libexec/foundry-mcp-npm
COPY dispatch.py /usr/local/libexec/foundry-mcp-ssh
COPY sshd.conf /etc/ssh/sshd_config.d/60-foundry-mcp.conf
RUN chmod 755 /usr/local/libexec/foundry-mcp-ssh && /usr/sbin/sshd -t
CMD ["/usr/sbin/sshd", "-D", "-e"]
