package cu.faustino.surtidor;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Surtidor Faustino: una pantalla web local (assets) dentro de un WebView. La parte web NO tiene acceso a la red (lo impide su política de seguridad de contenido): los cupones y los
 * canjes nunca salen por internet. Lo único que usa la red es esta parte nativa, y solo para una cosa: preguntarle a GitHub si hay una versión nueva de la aplicación y, si el
 * usuario lo acepta, descargarla. Lo demás que hace lo nativo es lo que una página no puede hacer sola: la cámara, elegir un archivo (abriendo en la carpeta de WhatsApp), recibir un
 * archivo desde WhatsApp y enviar o guardar el archivo de canjes.
 */
public class MainActivity extends Activity {
    private static final int PEDIR_CAMARA = 1;
    private static final int ELEGIR_ARCHIVO = 2;
    private static final int GUARDAR_ARCHIVO = 3;
    private static final String URL_VERSION = "https://api.github.com/repos/bryan9412/surtidor-faustino/releases/tags/apk";

    private WebView web;
    private PermissionRequest permisoPendiente;
    private ValueCallback<Uri[]> selectorArchivos;
    private String guardarContenido;

    // Un archivo recibido desde WhatsApp (o compartido) que se entrega a la página cuando termina de cargar.
    private String archivoPendienteNombre;
    private String archivoPendienteTexto;

    // La descarga de una actualización en curso.
    private long descargaId = -1;
    private File apkDescargado;
    private boolean receptorRegistrado = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        final WebViewAssetLoader cargador = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Puente(), "AndroidSurtidor");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return cargador.shouldInterceptRequest(r.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !"appassets.androidplatform.net".equals(r.getUrl().getHost()); // la página no sale de la aplicación
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                entregarArchivoPendiente();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(request.getResources());
                        } else {
                            permisoPendiente = request;
                            requestPermissions(new String[]{Manifest.permission.CAMERA}, PEDIR_CAMARA);
                        }
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (selectorArchivos != null) selectorArchivos.onReceiveValue(null);
                selectorArchivos = callback;
                try {
                    boolean imagen = false;
                    for (String tipo : params.getAcceptTypes()) {
                        if (tipo != null && tipo.startsWith("image/")) imagen = true;
                    }
                    Intent i;
                    if (imagen) {
                        i = params.createIntent(); // la galería, para «leer el QR de una foto»
                    } else {
                        // El archivo de cupones casi siempre llega por WhatsApp: el selector se abre en la carpeta donde WhatsApp guarda los documentos.
                        i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType("*/*");
                        if (Build.VERSION.SDK_INT >= 26) i.putExtra(DocumentsContract.EXTRA_INITIAL_URI, carpetaDeWhatsApp());
                    }
                    startActivityForResult(i, ELEGIR_ARCHIVO);
                } catch (Exception e) {
                    selectorArchivos = null;
                    Toast.makeText(MainActivity.this, "No se pudo abrir el selector de archivos.", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }
        });

        procesarIntent(getIntent());
        if (b != null) web.restoreState(b);
        else web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    /** Dónde guarda WhatsApp los documentos que recibe: en Android 11 o superior dentro de Android/media; antes, en la raíz. */
    private Uri carpetaDeWhatsApp() {
        String id = Build.VERSION.SDK_INT >= 30
                ? "primary:Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Documents"
                : "primary:WhatsApp/Media/WhatsApp Documents";
        return DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", id);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        procesarIntent(intent);
        entregarArchivoPendiente();
    }

    /** Si la aplicación se abrió desde un archivo (tocarlo en WhatsApp o «compartir»), lo lee para entregárselo a la página. */
    private void procesarIntent(Intent i) {
        if (i == null) return;
        String accion = i.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(accion)) uri = i.getData();
        else if (Intent.ACTION_SEND.equals(accion)) uri = (Uri) i.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            ByteArrayOutputStream salida = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                salida.write(buf, 0, n);
                if (salida.size() > 4 * 1024 * 1024) throw new Exception("archivo demasiado grande");
            }
            archivoPendienteTexto = salida.toString("UTF-8");
            archivoPendienteNombre = nombreDe(uri);
        } catch (Exception e) {
            Toast.makeText(this, "No se pudo abrir el archivo.", Toast.LENGTH_LONG).show();
        }
        i.setAction(Intent.ACTION_MAIN); // para no volver a leerlo al girar la pantalla
        i.setData(null);
    }

    private String nombreDe(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return c.getString(idx);
            }
        } catch (Exception e) {
            // se usa un nombre genérico
        }
        return "archivo.json";
    }

    private void entregarArchivoPendiente() {
        if (archivoPendienteTexto == null || web == null) return;
        String js = "window.recibirArchivo && window.recibirArchivo(" + JSONObject.quote(archivoPendienteNombre == null ? "archivo.json" : archivoPendienteNombre)
                + "," + JSONObject.quote(archivoPendienteTexto) + ")";
        archivoPendienteTexto = null;
        archivoPendienteNombre = null;
        web.evaluateJavascript(js, null);
    }

    @Override
    public void onRequestPermissionsResult(int codigo, String[] permisos, int[] resultados) {
        super.onRequestPermissionsResult(codigo, permisos, resultados);
        if (codigo == PEDIR_CAMARA && permisoPendiente != null) {
            if (resultados.length > 0 && resultados[0] == PackageManager.PERMISSION_GRANTED) permisoPendiente.grant(permisoPendiente.getResources());
            else permisoPendiente.deny();
            permisoPendiente = null;
        }
    }

    @Override
    protected void onActivityResult(int codigo, int resultado, Intent datos) {
        super.onActivityResult(codigo, resultado, datos);
        if (codigo == ELEGIR_ARCHIVO && selectorArchivos != null) {
            selectorArchivos.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultado, datos));
            selectorArchivos = null;
        } else if (codigo == GUARDAR_ARCHIVO) {
            if (resultado == RESULT_OK && datos != null && datos.getData() != null && guardarContenido != null) {
                try (OutputStream salida = getContentResolver().openOutputStream(datos.getData())) {
                    salida.write(guardarContenido.getBytes(StandardCharsets.UTF_8));
                    Toast.makeText(this, "Archivo guardado.", Toast.LENGTH_LONG).show();
                } catch (Exception e) {
                    Toast.makeText(this, "No se pudo guardar el archivo.", Toast.LENGTH_LONG).show();
                }
            }
            guardarContenido = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle b) {
        super.onSaveInstanceState(b);
        web.saveState(b);
    }

    @Override
    protected void onDestroy() {
        if (receptorRegistrado) {
            try {
                unregisterReceiver(receptorDescarga);
            } catch (Exception e) {
                // ya estaba suelto
            }
            receptorRegistrado = false;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // Primero la aplicación web (volver a la pantalla anterior); si no hay nada que volver, se sale.
        web.evaluateJavascript("(function(){return window.atras ? window.atras() : false;})()", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String atendido) {
                if (!"true".equals(atendido)) MainActivity.super.onBackPressed();
            }
        });
    }

    /* ---------- actualizaciones ---------- */

    private int versionActual() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private String nombreVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    /** Pregunta a GitHub cuál es la última versión publicada y se lo cuenta a la página. Sin conexión o sin acceso no pasa nada: la página lo muestra con calma. */
    private void comprobarActualizacion() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                JSONObject r = new JSONObject();
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(URL_VERSION).openConnection();
                    c.setConnectTimeout(6000);
                    c.setReadTimeout(8000);
                    c.setRequestProperty("Accept", "application/vnd.github+json");
                    c.setRequestProperty("User-Agent", "SurtidorFaustino");
                    int codigo = c.getResponseCode();
                    if (codigo != 200) {
                        r.put("estado", codigo == 404 ? "no_disponible" : "error");
                    } else {
                        ByteArrayOutputStream cuerpo = new ByteArrayOutputStream();
                        try (InputStream in = c.getInputStream()) {
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = in.read(buf)) > 0) cuerpo.write(buf, 0, n);
                        }
                        JSONObject rel = new JSONObject(cuerpo.toString("UTF-8"));
                        Matcher m = Pattern.compile("Versi.n\\s+(\\d+)").matcher(rel.optString("body"));
                        int nueva = m.find() ? Integer.parseInt(m.group(1)) : 0;
                        String url = "";
                        long tamano = 0;
                        JSONArray activos = rel.optJSONArray("assets");
                        if (activos != null) {
                            for (int k = 0; k < activos.length(); k++) {
                                JSONObject a = activos.getJSONObject(k);
                                if (a.optString("name").endsWith(".apk")) {
                                    url = a.optString("browser_download_url");
                                    tamano = a.optLong("size");
                                }
                            }
                        }
                        int actual = versionActual();
                        r.put("estado", (nueva > actual && !url.isEmpty()) ? "nueva" : "al_dia");
                        r.put("version", nueva);
                        r.put("actual", actual);
                        r.put("url", url);
                        r.put("tamano", tamano);
                    }
                } catch (java.net.UnknownHostException e) {
                    try { r.put("estado", "sin_conexion"); } catch (Exception x) { /* nada */ }
                } catch (java.net.SocketTimeoutException e) {
                    try { r.put("estado", "sin_conexion"); } catch (Exception x) { /* nada */ }
                } catch (Exception e) {
                    try { r.put("estado", "error"); } catch (Exception x) { /* nada */ }
                }
                final String js = "window.resultadoActualizacion && window.resultadoActualizacion(" + r.toString() + ")";
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        web.evaluateJavascript(js, null);
                    }
                });
            }
        }).start();
    }

    private final BroadcastReceiver receptorDescarga = new BroadcastReceiver() {
        @Override
        public void onReceive(Context contexto, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (id != descargaId || apkDescargado == null || !apkDescargado.exists()) return;
            try {
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".archivos", apkDescargado);
                Intent instalar = new Intent(Intent.ACTION_VIEW);
                instalar.setDataAndType(uri, "application/vnd.android.package-archive");
                instalar.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(instalar);
            } catch (Exception e) {
                Toast.makeText(MainActivity.this, "La descarga terminó pero no se pudo abrir el instalador.", Toast.LENGTH_LONG).show();
            }
        }
    };

    /** Descarga la actualización y, al terminar, abre el instalador de Android (el usuario confirma). Los canjes guardados se conservan: se instala encima de la versión actual. */
    private void instalarActualizacion(String url) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(this, "Permite instalar desde esta aplicación y vuelve a tocar «Actualizar».", Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            return;
        }
        try {
            File carpeta = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            apkDescargado = new File(carpeta, "Surtidor-Faustino-nueva.apk");
            if (apkDescargado.exists()) apkDescargado.delete();
            DownloadManager.Request pedido = new DownloadManager.Request(Uri.parse(url))
                    .setTitle("Surtidor Faustino")
                    .setDescription("Descargando la actualización")
                    .setDestinationUri(Uri.fromFile(apkDescargado))
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            DownloadManager gestor = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            descargaId = gestor.enqueue(pedido);
            if (!receptorRegistrado) {
                IntentFilter filtro = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                if (Build.VERSION.SDK_INT >= 33) registerReceiver(receptorDescarga, filtro, Context.RECEIVER_EXPORTED);
                else registerReceiver(receptorDescarga, filtro);
                receptorRegistrado = true;
            }
            Toast.makeText(this, "Descargando la actualización…", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "No se pudo descargar la actualización.", Toast.LENGTH_LONG).show();
        }
    }

    /** Lo que la página puede pedirle al teléfono. */
    private class Puente {
        @JavascriptInterface
        public String version() {
            return nombreVersion() + " (" + versionActual() + ")";
        }

        @JavascriptInterface
        public void buscarActualizacion() {
            comprobarActualizacion();
        }

        @JavascriptInterface
        public void instalarActualizacion(final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    // Solo se acepta bajar desde la página de lanzamientos de este proyecto.
                    if (url != null && url.startsWith("https://github.com/bryan9412/surtidor-faustino/releases/")) {
                        MainActivity.this.instalarActualizacion(url);
                    }
                }
            });
        }

        @JavascriptInterface
        public void compartir(final String nombre, final String contenido) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        File carpeta = new File(getCacheDir(), "exportar");
                        if (!carpeta.exists()) carpeta.mkdirs();
                        File archivo = new File(carpeta, nombre.replaceAll("[^A-Za-z0-9._-]", "_"));
                        try (FileOutputStream f = new FileOutputStream(archivo)) {
                            f.write(contenido.getBytes(StandardCharsets.UTF_8));
                        }
                        Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".archivos", archivo);
                        Intent enviar = new Intent(Intent.ACTION_SEND);
                        enviar.setType("application/json");
                        enviar.putExtra(Intent.EXTRA_STREAM, uri);
                        enviar.putExtra(Intent.EXTRA_SUBJECT, "Canjes de combustible");
                        enviar.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(enviar, "Enviar los canjes a la Dirección"));
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "No se pudo preparar el archivo para enviar.", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void guardar(final String nombre, final String contenido) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    guardarContenido = contenido;
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("application/json");
                    i.putExtra(Intent.EXTRA_TITLE, nombre);
                    startActivityForResult(i, GUARDAR_ARCHIVO);
                }
            });
        }
    }
}
