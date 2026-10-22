# Mikcort Voice

Kucuk odalar icin hafif masaustu sesli sohbet uygulamasi. Go ve Cloudflare backend'leri yalnizca signaling icindir; ses, ekran paylasimi ve medya verisi istemciler arasinda peer-to-peer WebRTC ile akar.

[English README](README.en.md)

## Proje Yapisi

```text
mikcort/
  frontend/                    Vue 3 + Tauri masaustu uygulamasi
    src/                       Frontend kaynak kodu
    src-tauri/                 Native masaustu kabugu
  backend/
    go/                        Self-host edilebilir Go signaling server
      cmd/server/
      internal/
    cloudflare-signaling/      Cloudflare Workers + Durable Objects signaling server
```

## Nasil Calisir?

Mikcort iki ana parcadan olusur:

- `frontend/`: masaustu istemci. Vue arayuzunu render eder, mikrofon/ekran stream'lerini acar, WebRTC peer connection'lari kurar ve uzak sesi oynatir.
- `backend/`: signaling backend'leri. Ses verisini almaz veya relay etmez. Sadece istemcilerin birbirini bulmasina ve WebRTC kurulum mesajlarini takas etmesine yardim eder.

Uygulama iki backend'den biriyle calisabilir:

- `backend/go/`: kucuk, self-host edilebilir WebSocket server.
- `backend/cloudflare-signaling/`: Cloudflare Workers + Durable Objects kullanan hosted signaling alternatifi.

Iki backend de ayni WebSocket mesaj kontratini konusur. Bu yuzden frontend tarafinda sadece signaling server URL'sini degistirerek Go veya Cloudflare backend'e gecebilirsin.

### Baglanti Akisi

1. Istemci uygulamayi acar ve signaling server'a `/ws` uzerinden baglanir.
2. Istemci `join-room` mesaji ile bir odaya girer.
3. Signaling backend odadaki kullanicilari takip eder ve yeni istemciye mevcut oda uyelerini yollar.
4. Istemciler WebRTC `offer`, `answer` ve `ice-candidate` mesajlarini signaling backend uzerinden takas eder.
5. WebRTC baglantisi kurulduktan sonra mikrofon sesi ve ekran paylasimi dogrudan istemciler arasinda peer-to-peer akar.
6. Chat mesajlari kucuk oda event'leri oldugu icin signaling backend uzerinden gitmeye devam eder.

```text
Masaustu istemci A  <-- WebRTC ses/ekran -->  Masaustu istemci B
          |                                            |
          +----------- WebSocket signaling ------------+
                           |
                    Go veya Cloudflare backend
```

### Gizlilik Ve Odalar

Odalar, ilk kullanici bir oda ID'sine girdiginde otomatik olusur. Oda public veya sifreli olabilir:

- Public odalarda oda listesindeki bagli kullanicilarin gorunen adlari listelenir.
- Sifreli odalarda odanin var oldugu gorunur, fakat kullanici isimleri ve kullanici sayisi gizlenir.
- Oda sifresi yalnizca signaling backend'in bellek icindeki oda state'inde tutulur ve oda bosalinca silinir.

Bu sayede proje hafif kalir: veritabani yok, hesap sistemi yok, merkezi medya server yok.

## Teknoloji

- Masaustu UI: Tauri + Vue 3 + TypeScript
- Backend secenek 1: Go standard library WebSocket signaling
- Backend secenek 2: Cloudflare Workers + Durable Objects
- Ses: WebRTC mesh peer-to-peer
- STUN: `stun:stun.l.google.com:19302`, `stun:global.stun.twilio.com:3478`
- Media server, database, auth, Kubernetes veya Redis yok

## Lokal Calistirma

Go signaling server'i baslat:

```powershell
cd backend/go
go run ./cmd/server
```

Server varsayilan olarak `:8080` uzerinden dinler. Degistirmek icin:

```powershell
cd backend/go
$env:ADDR=":9090"; go run ./cmd/server
```

Frontend bagimliliklarini kur:

```powershell
cd frontend
cmd /c npm install
```

Tauri uygulamasini development modda calistir:

```powershell
cd frontend
cmd /c npm run tauri dev
```

Hizli tarayici testi icin sadece web UI da calistirilabilir:

```powershell
cd frontend
cmd /c npm run dev
```

## Kullanim

1. Bir signaling backend baslat.
2. Iki veya daha fazla uygulama instance'i ac.
3. Bir instance'ta oda olustur.
4. Diger instance'lardan ayni oda ID'sine gir.
5. Opsiyonel: oda sifresi belirleyerek public oda listesindeki kullanici bilgisini gizle.
6. Her instance'ta **Start microphone** butonuna bas.

## Kontroller

```powershell
cd backend/go
go test ./...
go build ./...
```

```powershell
cd frontend
cmd /c npm run build
```

```powershell
cd backend/cloudflare-signaling
cmd /c npm run typecheck
```

Tauri native build'leri icin Rust toolchain ve platforma ozel Tauri gereksinimleri de gerekir.

## Masaustu Otomatik Guncellemeler

Tauri masaustu uygulamasi resmi Tauri updater plugin'ini ve GitHub Releases'i kullanir.

Updater endpoint:

```text
https://github.com/mehmeCelenk/mikcort/releases/latest/download/latest.json
```

Uygulama baslangicta guncelleme kontrolu yapar. Guncelleme varsa indirip kurar ve kullanicidan yeniden baslatma ister.

### Imzalama Anahtarlari

Guncellemeler imzalanir. Public key `frontend/src-tauri/tauri.conf.json` icinde tutulur. Private key gizli kalmali ve Git tarafindan `frontend/.tauri/` altinda ignore edilir.

Yeni keypair'i sadece yeni bir update kanali baslatirken uret:

```powershell
cd frontend
cmd /c npm run tauri signer generate -- --ci -f -w .tauri\mikcort-updater.key
```

Uretilen public key'i `frontend/src-tauri/tauri.conf.json` icinde kullan.

GitHub repository secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Key `--ci` ile ve sifresiz uretildiyse `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` bos string olabilir veya hic tanimlanmayabilir.

### Yeni Versiyon Cikarma

Semantic versioning kullan, ornegin `0.2.12`.

1. Version alanlarini guncelle:
   - `frontend/package.json`
   - `frontend/src-tauri/Cargo.toml`
   - `frontend/src-tauri/tauri.conf.json`
2. Version bump commit'i at.
3. Ayni version tag'ini olusturup pushla:

```powershell
git tag v0.2.12
git push origin main v0.2.12
```

`Release desktop app` workflow'u Windows app ve universal macOS desktop app build eder, updater artifact'larini imzalar, GitHub Release olusturur ve `latest.json` yukler.

## Docker Backend

Go signaling server image'ini build ve push et:

```powershell
docker build -t mehmetcelenk/mikcort:latest backend/go
docker push mehmetcelenk/mikcort:latest
```

Bir VM uzerinde host port `8081` yayinlayarak calistir:

```bash
docker run -d --name mikcort-signaling --restart unless-stopped -p 8081:8080 mehmetcelenk/mikcort:latest
```

Masaustu istemciler su URL'yi kullanabilir:

```text
ws://SERVER_IP:8081/ws
```

## Cloudflare Workers Backend

Alternatif signaling backend `backend/cloudflare-signaling/` altindadir. Cloudflare Workers + Durable Objects kullanir ve Go backend ile ayni WebSocket mesaj kontratini korur.

```bash
cd backend/cloudflare-signaling
npm install
npm run deploy
```

Masaustu istemciler deploy edilen Worker URL'sini kullanabilir:

```text
wss://mikcort-signaling.<your-subdomain>.workers.dev/ws
```

Cloudflare backend de sadece signaling yapar. WebRTC sesi peer-to-peer kalir.

## Lisans

Bu proje [MIT Lisansi](LICENSE) altinda yayinlanir.
