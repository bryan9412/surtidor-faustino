package cu.faustino.surtidor;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
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

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Surtidor Faustino: una pantalla web local (assets) dentro de un WebView, sin conexión. La aplicación NO pide el permiso de Internet: no puede salir a la red aunque quisiera.
 * Lo único nativo es lo que una página no puede hacer sola: el permiso de la cámara, elegir un archivo y enviar o guardar el archivo de canjes.
 */
public class MainActivity extends Activity {
    private static final int PEDIR_CAMARA = 1;
    private static final int ELEGIR_ARCHIVO = 2;
    private static final int GUARDAR_ARCHIVO = 3;

    private WebView web;
    private PermissionRequest permisoPendiente;
    private ValueCallback<Uri[]> selectorArchivos;
    private String guardarContenido;

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
                return !"appassets.androidplatform.net".equals(r.getUrl().getHost()); // nada sale de la aplicación
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
                    startActivityForResult(params.createIntent(), ELEGIR_ARCHIVO);
                } catch (Exception e) {
                    selectorArchivos = null;
                    Toast.makeText(MainActivity.this, "No se pudo abrir el selector de archivos.", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }
        });

        if (b != null) web.restoreState(b);
        else web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
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
    public void onBackPressed() {
        // Primero la aplicación web (volver a la pantalla anterior); si no hay nada que volver, se sale.
        web.evaluateJavascript("(function(){return window.atras ? window.atras() : false;})()", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String atendido) {
                if (!"true".equals(atendido)) MainActivity.super.onBackPressed();
            }
        });
    }

    /** Lo que la página puede pedirle al teléfono: enviar o guardar el archivo de canjes. */
    private class Puente {
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
