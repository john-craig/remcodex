# RemCodex mobile app

This Android module is a native shell around the existing RemCodex web client.
It uses the Gitea `chiliahedron/kotlin-template` as its Gradle/Kotlin scaffold
and keeps the server as the source of session, API, and WebSocket behavior.

The debug build defaults to `http://10.0.2.2:3000/` for an Android emulator.
Pass a different server URL with the `com.chiliahedron.remcodex.SERVER_URL`
intent extra, or launch the activity with a URL as its intent data.

From this directory:

```text
gradle assembleDebug
```
